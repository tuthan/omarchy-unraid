import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Api.js" as Api

Panel {
  id: root
  moduleName: "io.github.hvo.omarchy-unraid"
  ipcTarget: "io.github.hvo.omarchy-unraid"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property var barIdentity: hostWidget || root
  readonly property bool unraidTheme: hostWidget ? hostWidget.unraidTheme === true : false
  readonly property color themeAccent: unraidTheme ? "#EE7F3C" : Color.accent
  readonly property color themeUrgent: unraidTheme ? "#D64541" : Color.urgent
  readonly property color fg: unraidTheme ? "#EAEAEA" : barForeground
  readonly property color mutedFg: unraidTheme ? "#9B9BA1" : Qt.darker(fg, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var snapshot: hostWidget ? hostWidget.snapshot : null
  readonly property string lastError: hostWidget ? hostWidget.lastError : ""
  readonly property bool configured: hostWidget ? hostWidget.configured : false
  readonly property var dockerCounts: hostWidget && hostWidget.dockerCounts ? hostWidget.dockerCounts : { running: 0, total: 0 }

  readonly property var tabs: ["Array", "System", "Docker", "VMs", "Setup"]
  property int activeIndex: 0

  readonly property int historyMax: 90
  property var cpuHistory: []
  property var memHistory: []
  property var parityInfo: null
  readonly property string dashboardUrl: hostWidget && hostWidget.serverUrl ? Api.dashboardUrl(hostWidget.serverUrl, hostWidget.transport) : ""
  readonly property bool manageAllowed: configured && !!hostWidget && hostWidget.manageMode === true

  property string actionMessage: ""
  property string actionError: ""

  onSnapshotChanged: pushSystemPoint()

  function pushSystemPoint() {
    if (!root.snapshot || !root.snapshot.system) return
    var sys = root.snapshot.system
    if (sys.cpuPercent === null && sys.memPercent === null) return
    var cpu = root.cpuHistory.slice()
    cpu.push(sys.cpuPercent)
    while (cpu.length > root.historyMax) cpu.shift()
    root.cpuHistory = cpu
    var mem = root.memHistory.slice()
    mem.push(sys.memPercent)
    while (mem.length > root.historyMax) mem.shift()
    root.memHistory = mem
  }

  function padSeries(hist) {
    var out = []
    var i
    for (i = hist.length; i < root.historyMax; i++) out.push(null)
    for (i = 0; i < hist.length; i++) out.push(hist[i])
    return out
  }

  function fetchParityInfo() {
    if (!hostWidget || !hostWidget.configured) return
    if (parityProc.running) return
    parityProc.command = Api.parityRequestArgs(hostWidget.serverUrl, hostWidget.apiKey, hostWidget.allowSelfSigned, hostWidget.transport)
    parityProc.running = true
  }

  function paritySummary(p) {
    if (!p) return "\u2013"
    var parts = []
    if ((p.checkStatus === "RUNNING" || p.checkStatus === "PAUSED") && p.progress !== null)
      parts.push(p.checkStatus + " " + p.progress + "%")
    else
      parts.push(p.checkStatus)
    if (p.lastDate) {
      parts.push("last " + Api.relativeTime(p.lastDate))
      if (p.lastErrors !== null && p.lastErrors > 0) parts.push(p.lastErrors.toLocaleString() + " err")
    }
    return parts.join("   \u00B7   ")
  }

  function parityAlert(p) {
    if (!p) return false
    return p.checkStatus === "FAILED" || (p.lastErrors !== null && p.lastErrors > 0)
  }

  component DiskRow: Item {
    id: diskRow

    property var disk: null
    readonly property real pct: Api.diskUsedPercent(disk)
    readonly property string label: {
      if (!disk) return ""
      var name = String(disk.name || "?")
      if (!Api.diskOk(disk.status))
        name += "   \u00B7   " + Api.shortStatus(disk.status)
      return name
    }

    width: parent ? parent.width : 0
    height: diskColumn.implicitHeight

    Column {
      id: diskColumn
      width: parent.width
      spacing: Style.space(4)

      Row {
        width: parent.width
        spacing: Style.space(6)

        Text {
          width: parent.width - tempLabel.implicitWidth - parent.spacing
          elide: Text.ElideRight
          text: diskRow.label
          color: diskRow.disk && !Api.diskOk(diskRow.disk.status) ? root.themeUrgent : root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          textFormat: Text.PlainText
        }

        Text {
          id: tempLabel
          text: !diskRow.disk || diskRow.disk.tempC === null ? "\u2013\u00B0C" : diskRow.disk.tempC + "\u00B0C"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      Row {
        visible: diskRow.pct !== null
        width: parent.width
        spacing: Style.space(6)

        Rectangle {
          id: barTrack
          width: parent.width - pctText.implicitWidth - parent.spacing
          height: Style.space(5)
          radius: height / 2
          anchors.verticalCenter: parent.verticalCenter
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)

          Rectangle {
            width: parent.width * (diskRow.pct === null ? 0 : diskRow.pct / 100)
            height: parent.height
            radius: parent.radius
            color: diskRow.pct !== null && diskRow.pct > 90 ? root.themeUrgent : root.fg

            Behavior on width { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }
          }
        }

        Text {
          id: pctText
          anchors.verticalCenter: parent.verticalCenter
          text: diskRow.pct === null ? "" : diskRow.pct + "%"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  component MetricGraph: Item {
    id: graph

    property var series: []
    property color lineColor: root.themeAccent
    property real maxValue: 100

    Canvas {
      id: canvas
      anchors.fill: parent
      antialiasing: true
      renderStrategy: Canvas.Immediate

      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var w = width
        var h = height

        ctx.lineWidth = 1
        ctx.strokeStyle = Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.10)
        for (var g = 1; g <= 3; g++) {
          var gy = Math.round(h - (h * g / 4)) + 0.5
          ctx.beginPath()
          ctx.moveTo(0, gy)
          ctx.lineTo(w, gy)
          ctx.stroke()
        }

        var vals = graph.series || []
        var start = 0
        while (start < vals.length && vals[start] === null) start++
        if (vals.length - start < 2) return
        var n = vals.length - start
        var stepX = w / (vals.length - 1)
        function px(i) { return (start + i) * stepX }
        function py(v) {
          var f = graph.maxValue > 0 ? Math.min(1, v / graph.maxValue) : 0
          return h - h * f
        }

        ctx.beginPath()
        ctx.moveTo(px(0), py(vals[start]))
        for (var i = 1; i < n; i++) ctx.lineTo(px(i), py(vals[start + i]))
        ctx.lineTo(px(n - 1), h)
        ctx.lineTo(px(0), h)
        ctx.closePath()
        var grad = ctx.createLinearGradient(0, 0, 0, h)
        grad.addColorStop(0, Qt.rgba(graph.lineColor.r, graph.lineColor.g, graph.lineColor.b, 0.30))
        grad.addColorStop(1, Qt.rgba(graph.lineColor.r, graph.lineColor.g, graph.lineColor.b, 0.02))
        ctx.fillStyle = grad
        ctx.fill()

        ctx.beginPath()
        ctx.moveTo(px(0), py(vals[start]))
        for (i = 1; i < n; i++) ctx.lineTo(px(i), py(vals[start + i]))
        ctx.strokeStyle = String(graph.lineColor)
        ctx.lineWidth = 2
        ctx.lineJoin = "round"
        ctx.lineCap = "round"
        ctx.stroke()
      }
    }

    onSeriesChanged: canvas.requestPaint()
    onLineColorChanged: canvas.requestPaint()
    onWidthChanged: canvas.requestPaint()
    onHeightChanged: canvas.requestPaint()
  }

  component StatusLine: Item {
    id: line

    property string label: ""
    property string value: ""
    property bool alert: false

    width: parent ? parent.width : 0
    height: Math.max(lineLabel.implicitHeight, lineValue.implicitHeight)

    Text {
      id: lineLabel
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      text: line.label
      color: root.mutedFg
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.letterSpacing: 1
      textFormat: Text.PlainText
    }

    Text {
      id: lineValue
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: line.value
      color: line.alert ? root.themeUrgent : root.fg
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      textFormat: Text.PlainText
    }
  }

  component ActionBanner: Text {
    visible: root.actionMessage !== "" || root.actionError !== ""
    width: parent ? parent.width : 0
    text: root.actionError !== "" ? root.actionError : root.actionMessage
    color: root.actionError !== "" ? root.themeUrgent : root.themeAccent
    elide: Text.ElideRight
    textFormat: Text.PlainText
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  function setActive(index) {
    root.activeIndex = index
    if (index === 0 || index === 1) root.fetchParityInfo()
  }

  Process {
    id: parityProc

    stdout: StdioCollector { id: parityOut; waitForEnd: true }
    stderr: StdioCollector { id: parityErr; waitForEnd: true }

    onExited: {
      var result = Api.parseParity(parityOut.text, parityErr.text)
      root.parityInfo = result.ok ? result.parity : null
    }
  }

  property string actionLabel: ""
  property var queuedFollowUp: null

  function runAction(label, queryText, followUp) {
    if (!root.manageAllowed) return
    if (actionProc.running) return
    root.executeAction(label, queryText, followUp)
  }

  function executeAction(label, queryText, followUp) {
    if (actionProc.running) return
    console.warn("[unraid] action:", label)
    root.actionLabel = label
    root.queuedFollowUp = followUp || null
    actionProc.command = Api.mutationArgs(hostWidget.serverUrl, hostWidget.apiKey, hostWidget.allowSelfSigned, queryText, hostWidget.transport)
    actionProc.running = true
  }

  function dockerMutation(action, id) {
    return "mutation M { docker { " + action + "(id: " + JSON.stringify(String(id || "")) + ") { id } } }"
  }

  function vmMutation(action, id) {
    return "mutation M { vm { " + action + "(id: " + JSON.stringify(String(id || "")) + ") } }"
  }

  function arrayMutation(desiredState) {
    return "mutation M { array { setState(input: { desiredState: " + desiredState + " }) { state } } }"
  }

  function parityMutation(action) {
    if (action === "start") return "mutation M { parityCheck { start(correct: false) } }"
    return "mutation M { parityCheck { " + action + " } }"
  }

  Timer {
    id: actionClearTimer
    interval: 6000
    onTriggered: {
      root.actionMessage = ""
      root.actionError = ""
    }
  }

  Process {
    id: actionProc

    stdout: StdioCollector { id: actionOut; waitForEnd: true }
    stderr: StdioCollector { id: actionErr; waitForEnd: true }

    onExited: {
      var result = Api.parseActionResult(actionOut.text, actionErr.text)
      if (result.ok && root.queuedFollowUp) {
        var next = root.queuedFollowUp
        root.queuedFollowUp = null
        root.executeAction(next.label, next.query, next.followUp || null)
        return
      }
      root.queuedFollowUp = null
      if (result.ok) {
        root.actionMessage = root.actionLabel + ": done"
        root.actionError = ""
      } else {
        root.actionMessage = ""
        root.actionError = root.actionLabel + ": " + result.error
      }
      actionClearTimer.restart()
      if (hostWidget && typeof hostWidget.refresh === "function") hostWidget.refresh()
      root.fetchParityInfo()
    }
  }

  component ActionButton: Rectangle {
    id: actionBtn

    property string label: ""
    property bool destructive: false
    property bool needsConfirm: false
    property bool armed: false
    signal clicked()

    width: actionLabel.implicitWidth + Style.space(18)
    height: actionLabel.implicitHeight + Style.space(8)
    radius: height / 2
    readonly property color fgColor: armed || destructive ? root.themeUrgent : root.themeAccent
    color: actionMouse.containsMouse
      ? Qt.rgba(fgColor.r, fgColor.g, fgColor.b, 0.22)
      : Qt.rgba(fgColor.r, fgColor.g, fgColor.b, 0.10)

    Behavior on color { ColorAnimation { duration: 120 } }

    Text {
      id: actionLabel
      anchors.centerIn: parent
      text: actionBtn.armed ? "CONFIRM?" : actionBtn.label
      color: actionBtn.fgColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      textFormat: Text.PlainText
    }

    Timer {
      id: armTimer
      interval: 4000
      onTriggered: actionBtn.armed = false
    }

    MouseArea {
      id: actionMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      enabled: root.manageAllowed && !actionProc.running
      onClicked: {
        if (!actionBtn.enabled) return
        if (actionBtn.needsConfirm && !actionBtn.armed) {
          actionBtn.armed = true
          armTimer.restart()
          return
        }
        actionBtn.armed = false
        actionBtn.clicked()
      }
    }
  }

  function switchTabBy(delta) {
    setActive((activeIndex + delta + tabs.length) % tabs.length)
  }

  function refreshAll() {
    if (hostWidget && typeof hostWidget.refresh === "function") hostWidget.refresh()
  }

  function statusTitle() {
    if (!configured) return "Not configured"
    if (lastError !== "") return "Server unreachable"
    if (!snapshot) return "Waiting for first response\u2026"
    if (snapshot.arrayState === "STARTED") return "Array started"
    if (snapshot.arrayState === "STOPPED") return "Array stopped"
    return "Array " + snapshot.arrayState
  }

  function saveSetupValues(url, key, poll, selectedTransport, selectedAllowSelfSigned) {
    if (!hostWidget || typeof hostWidget.saveSettings !== "function") return
    hostWidget.saveSettings({
      serverUrl: String(url).replace(/\s+/g, ""),
      apiKey: String(key).replace(/^\s+|\s+$/g, ""),
      pollSeconds: Api.clampPollSeconds(poll),
      transport: selectedTransport === "http" ? "http" : "https",
      allowSelfSigned: selectedAllowSelfSigned === true
    })
    setActive(0)
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.switchTabBy(dx > 0 ? 1 : -1)
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "1") root.setActive(0)
        else if (t === "2") root.setActive(1)
        else if (t === "3") root.setActive(2)
        else if (t === "4") root.setActive(3)
        else if (t === "5") root.setActive(4)
        else if (t === "r" || t === "R") root.refreshAll()
      }

      Flickable {
        id: panelScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: panelScroll.width
          spacing: Style.space(10)

        Row {
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: root.tabs

            Item {
              required property int index
              required property string modelData

              width: tabLabel.implicitWidth + Style.space(18)
              height: Style.space(24)

              Text {
                id: tabLabel
                anchors.centerIn: parent
                text: modelData.toUpperCase()
                color: index === root.activeIndex ? root.fg : root.mutedFg
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: index === root.activeIndex
                font.letterSpacing: 1
              }

              Rectangle {
                anchors.bottom: parent.bottom
                anchors.horizontalCenter: parent.horizontalCenter
                width: tabLabel.implicitWidth
                height: Style.spacing.hairline
                color: root.fg
                opacity: index === root.activeIndex ? 0.85 : 0
              }

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.setActive(index)
              }
            }
          }

          Item {
            width: parent.width
            height: Style.space(24)

            PanelActionButton {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              iconText: "\uE9F4"
              tooltipText: "Refresh now (R)"
              foreground: root.fg
              fontFamily: root.fontFamily

              onClicked: root.refreshAll()
            }
          }
        }

        Item {
          width: parent.width
          height: statusRow.height

          Row {
            id: statusRow
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Rectangle {
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(10)
              height: width
              radius: width / 2
              color: root.hostWidget ? root.hostWidget.statusColor : Color.muted
            }

            Column {
              spacing: Style.space(2)

              Text {
                text: root.statusTitle()
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
                textFormat: Text.PlainText
              }

              Text {
                visible: root.lastError !== ""
                text: root.lastError
                color: root.mutedFg
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                textFormat: Text.PlainText
              }
            }
          }
        }

        Loader {
          id: tabArea
          width: parent.width
          sourceComponent: [arrayTabComponent, systemTabComponent, dockerTabComponent, vmsTabComponent, setupTabComponent][root.activeIndex]
        }
      }
    }
  }

  }

  Component {
    id: arrayTabComponent

    Column {
      width: tabArea.width
      spacing: Style.space(6)

      Text {
        visible: !root.snapshot
        width: parent.width
        text: root.configured ? "No data yet \u2014 press R to refresh." : "Configure the server URL and API key under Setup."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      ActionBanner {}

      Row {
        visible: root.manageAllowed && root.snapshot !== null
        width: parent.width
        spacing: Style.space(6)

        ActionButton {
          visible: root.snapshot && root.snapshot.arrayState !== "STARTED"
          label: "START ARRAY"
          onClicked: root.runAction("Start array", root.arrayMutation("START"))
        }

        ActionButton {
          visible: root.snapshot && root.snapshot.arrayState === "STARTED"
          label: "STOP ARRAY"
          destructive: true
          needsConfirm: true
          onClicked: root.runAction("Stop array", root.arrayMutation("STOP"))
        }

        ActionButton {
          visible: {
            var s = root.parityInfo ? root.parityInfo.checkStatus : ""
            return s === "RUNNING" || s === "PAUSED"
          }
          label: root.parityInfo && root.parityInfo.checkStatus === "PAUSED" ? "RESUME CHECK" : "PAUSE CHECK"
          onClicked: root.runAction("Parity check",
            root.parityMutation(root.parityInfo && root.parityInfo.checkStatus === "PAUSED" ? "resume" : "pause"))
        }

        ActionButton {
          visible: {
            var s = root.parityInfo ? root.parityInfo.checkStatus : ""
            return s === "RUNNING" || s === "PAUSED"
          }
          label: "CANCEL CHECK"
          destructive: true
          needsConfirm: true
          onClicked: root.runAction("Cancel parity check", root.parityMutation("cancel"))
        }

        ActionButton {
          visible: {
            var s = root.parityInfo ? root.parityInfo.checkStatus : ""
            return s !== "RUNNING" && s !== "PAUSED"
          }
          label: "START CHECK"
          onClicked: root.runAction("Start parity check", root.parityMutation("start"))
        }
      }

      Column {
        visible: root.snapshot !== null
        width: parent.width
        spacing: Style.space(8)

        Text {
          text: "DATA DISKS"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
        }

        Repeater {
          model: root.snapshot ? root.snapshot.disks : []

          delegate: DiskRow { disk: modelData }
        }

        Text {
          visible: root.snapshot && root.snapshot.disks.length === 0
          text: "No data disks reported."
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          visible: root.snapshot && root.snapshot.caches.length > 0
          text: "CACHE"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
        }

        Repeater {
          model: root.snapshot ? root.snapshot.caches : []

          delegate: DiskRow { disk: modelData }
        }

        Text {
          visible: root.snapshot && root.snapshot.parities.length > 0
          text: "PARITY"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
        }

        Repeater {
          model: root.snapshot ? root.snapshot.parities : []

          delegate: DiskRow { disk: modelData }
        }
      }
    }
  }

  Component {
    id: systemTabComponent

    Column {
      width: tabArea.width
      spacing: Style.space(8)

      readonly property var sys: root.snapshot ? root.snapshot.system : null
      readonly property real cpuNow: sys && sys.cpuPercent !== null ? sys.cpuPercent : -1
      readonly property real memNow: sys && sys.memPercent !== null ? sys.memPercent : -1

      Text {
        visible: !sys || sys.cpuPercent === null
        width: parent.width
        text: "No system data yet \u2014 press R to refresh."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Text {
        visible: sys && (sys.hostname !== "" || sys.cpuBrand !== "")
        width: parent.width
        elide: Text.ElideRight
        text: {
          if (!sys) return ""
          var parts = []
          if (sys.hostname !== "") parts.push(sys.hostname)
          if (sys.cpuBrand !== "") parts.push(sys.cpuBrand)
          return parts.join("   \u00B7   ")
        }
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }

      Item {
        visible: sys && sys.cpuPercent !== null
        width: parent.width
        height: sectionCaption.implicitHeight

        Text {
          id: sectionCaption
          anchors.left: parent.left
          text: "CPU"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
        }

        Text {
          anchors.right: parent.right
          text: cpuNow < 0 ? "" : Math.round(cpuNow) + "%"
          color: cpuNow > 90 ? root.themeUrgent : root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }
      }

      MetricGraph {
        visible: sys && sys.cpuPercent !== null
        width: parent.width
        height: Style.space(64)
        series: root.padSeries(root.cpuHistory)
        lineColor: root.themeAccent
      }

      Row {
        id: coreRow

        readonly property int count: sys ? sys.cores.length : 0
        width: parent.width
        spacing: Style.space(4)

        Repeater {
          model: sys ? sys.cores : []

          delegate: Rectangle {
            required property var modelData
            required property int index

            width: coreRow.count > 0 ? (coreRow.width - (coreRow.count - 1) * coreRow.spacing) / coreRow.count : 0
            height: Style.space(24)
            radius: 2
            color: Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.14)

            Rectangle {
              anchors.bottom: parent.bottom
              width: parent.width
              height: parent.height * Math.min(1, modelData / 100)
              radius: parent.radius
              color: modelData > 90 ? root.themeUrgent : root.themeAccent

              Behavior on height { NumberAnimation { duration: 250; easing.type: Easing.OutCubic } }
            }
          }
        }
      }

      Item {
        visible: sys && sys.memPercent !== null
        width: parent.width
        height: memCaption.implicitHeight

        Text {
          id: memCaption
          anchors.left: parent.left
          text: "MEMORY"
          color: root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
        }

        Text {
          anchors.right: parent.right
          text: memNow < 0 ? "" : Math.round(memNow) + "%"
          color: memNow > 90 ? root.themeUrgent : root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }
      }

      MetricGraph {
        visible: sys && sys.memPercent !== null
        width: parent.width
        height: Style.space(64)
        series: root.padSeries(root.memHistory)
        lineColor: root.fg
      }

      Text {
        visible: sys && sys.memPercent !== null && sys.memTotal > 0
        text: sys ? Api.humanSize(sys.memUsed) + " of " + Api.humanSize(sys.memTotal) : ""
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Text {
        visible: sys && sys.swapTotal > 0
        text: sys ? "SWAP   \u00B7   " + (sys.swapPercent === null ? "\u2013" : sys.swapPercent + "%") + " of " + Api.humanSize(sys.swapTotal) : ""
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Text {
        text: "SERVER"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      StatusLine {
        visible: root.parityInfo && root.parityInfo.bootTime !== ""
        label: "UPTIME"
        value: {
          var up = Api.uptimeHuman(root.parityInfo ? root.parityInfo.bootTime : "")
          return up === "" ? "\u2013" : up
        }
      }

      StatusLine {
        visible: true
        label: "PARITY"
        value: root.paritySummary(root.parityInfo)
        alert: root.parityAlert(root.parityInfo)
      }

      StatusLine {
        visible: {
          var hottest = root.snapshot ? Api.hottestDisk((root.snapshot.disks || []).concat(root.snapshot.caches || [])) : null
          return hottest !== null
        }
        label: "TEMP"
        value: {
          var hottest = root.snapshot ? Api.hottestDisk((root.snapshot.disks || []).concat(root.snapshot.caches || [])) : null
          return hottest === null ? "\u2013" : hottest + "\u00B0C" + "   \u00B7   hottest disk"
        }
        alert: {
          var hottest = root.snapshot ? Api.hottestDisk((root.snapshot.disks || []).concat(root.snapshot.caches || [])) : null
          return hottest !== null && hottest > 45
        }
      }

      Rectangle {
        visible: root.dashboardUrl !== ""
        width: parent.width
        height: dashLabel.implicitHeight + Style.space(14)
        radius: height / 2
        color: dashMouse.containsMouse
          ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.18)
          : Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.08)

        Behavior on color { ColorAnimation { duration: 120 } }

        Text {
          id: dashLabel
          anchors.centerIn: parent
          text: "Open Unraid dashboard   \u2197"
          color: root.themeAccent
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
        }

        MouseArea {
          id: dashMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: Qt.openUrlExternally(root.dashboardUrl)
        }
      }
    }
  }

  Component {
    id: dockerTabComponent

    Column {
      width: tabArea.width
      spacing: Style.space(6)

      Text {
        text: root.dockerCounts.running + " of " + root.dockerCounts.total + " containers running"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      ActionBanner {}

      Repeater {
        model: root.snapshot ? root.snapshot.containers : []

        delegate: Row {
          id: containerRow

          required property var modelData

          readonly property bool running: Api.containerRunning(modelData.state)

          width: tabArea.width
          height: containerName.implicitHeight
          spacing: Style.space(8)

          Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(7)
            height: width
            radius: width / 2
            color: containerRow.running ? root.themeAccent : root.mutedFg
          }

          Text {
            id: containerName
            width: parent.width - Style.space(120) - (root.manageAllowed ? Style.space(190) : 0)
            elide: Text.ElideRight
            text: modelData.name
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(70)
            text: modelData.state
            color: containerRow.running ? root.mutedFg : Qt.darker(root.mutedFg, 1.3)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.autoStart ? "\u21BB on" : ""
            color: root.mutedFg
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          ActionButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.manageAllowed && containerRow.running
            label: "RESTART"
            onClicked: root.runAction("Restart " + containerRow.modelData.name,
              root.dockerMutation("stop", containerRow.modelData.id),
              { label: "Start " + containerRow.modelData.name, query: root.dockerMutation("start", containerRow.modelData.id) })
          }

          ActionButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.manageAllowed && !containerRow.running
            label: "START"
            onClicked: root.runAction("Start " + containerRow.modelData.name,
              root.dockerMutation("start", containerRow.modelData.id), false)
          }

          ActionButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.manageAllowed && containerRow.running
            label: "STOP"
            destructive: true
            needsConfirm: true
            onClicked: root.runAction("Stop " + containerRow.modelData.name,
              root.dockerMutation("stop", containerRow.modelData.id))
          }
        }
      }

      Text {
        visible: root.snapshot && root.snapshot.containers.length === 0
        text: "No Docker containers reported."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  Component {
    id: vmsTabComponent

    Column {
      width: tabArea.width
      spacing: Style.space(6)

      ActionBanner {}

      Repeater {
        model: root.snapshot ? root.snapshot.vms : []

        delegate: Row {
          id: vmRow

          required property var modelData

          readonly property bool running: Api.vmRunning(modelData.state)

          width: tabArea.width
          height: vmName.implicitHeight
          spacing: Style.space(8)

          Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(7)
            height: width
            radius: width / 2
            color: vmRow.running ? root.themeAccent : root.mutedFg
          }

          Text {
            id: vmName
            width: parent.width - Style.space(90) - (root.manageAllowed ? Style.space(110) : 0)
            elide: Text.ElideRight
            text: modelData.name
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: modelData.state
            color: vmRow.running ? root.mutedFg : Qt.darker(root.mutedFg, 1.3)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }

          ActionButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.manageAllowed && !vmRow.running
            label: "START"
            onClicked: root.runAction("Start " + vmRow.modelData.name,
              root.vmMutation("start", vmRow.modelData.id), false)
          }

          ActionButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.manageAllowed && vmRow.running
            label: "STOP"
            destructive: true
            needsConfirm: true
            onClicked: root.runAction("Stop " + vmRow.modelData.name,
              root.vmMutation("stop", vmRow.modelData.id))
          }
        }
      }

      Text {
        visible: !root.snapshot || root.snapshot.vms.length === 0
        text: "No VMs reported."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  Component {
    id: setupTabComponent

    Column {
      id: setupColumn
      width: tabArea.width
      spacing: Style.space(6)
      property string selectedTransport: "https"
      property bool selectedAllowSelfSigned: false

      function commit() {
        root.saveSetupValues(urlField.text, keyField.text, pollField.text,
          setupColumn.selectedTransport, setupColumn.selectedAllowSelfSigned)
      }

      Component.onCompleted: {
        var s = root.hostWidget && root.hostWidget.settings ? root.hostWidget.settings : {}
        urlField.text = s.serverUrl !== undefined && s.serverUrl !== null ? String(s.serverUrl) : ""
        keyField.text = s.apiKey !== undefined && s.apiKey !== null ? String(s.apiKey) : ""
        pollField.text = String(root.hostWidget ? root.hostWidget.pollSeconds : 30)
        setupColumn.selectedTransport = root.hostWidget ? root.hostWidget.transport : "https"
        setupColumn.selectedAllowSelfSigned = root.hostWidget ? root.hostWidget.allowSelfSigned : false
      }

      Text {
        text: "SERVER URL"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      TextField {
        id: urlField
        width: parent.width
        placeholderText: "tower.local"
        foreground: root.fg
        font.family: root.fontFamily

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            setupColumn.commit()
            event.accepted = true
          } else if (event.key === Qt.Key_Escape) {
            root.close()
            event.accepted = true
          }
        }
      }

      Text {
        text: "TRANSPORT"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      Row {
        width: parent.width
        spacing: Style.space(6)

        Rectangle {
          id: httpsOption
          readonly property bool selected: setupColumn.selectedTransport === "https"
          width: (parent.width - parent.spacing) / 2
          height: httpsLabel.implicitHeight + Style.space(14)
          radius: Style.space(4)
          color: selected
            ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.18)
            : "transparent"
          border.width: 1
          border.color: selected ? root.themeAccent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)

          Text {
            id: httpsLabel
            anchors.centerIn: parent
            text: "HTTPS"
            color: httpsOption.selected ? root.themeAccent : root.mutedFg
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: httpsOption.selected
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: setupColumn.selectedTransport = "https"
          }
        }

        Rectangle {
          id: httpOption
          readonly property bool selected: setupColumn.selectedTransport === "http"
          width: (parent.width - parent.spacing) / 2
          height: httpLabel.implicitHeight + Style.space(14)
          radius: Style.space(4)
          color: selected
            ? Qt.rgba(root.themeUrgent.r, root.themeUrgent.g, root.themeUrgent.b, 0.18)
            : "transparent"
          border.width: 1
          border.color: selected ? root.themeUrgent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)

          Text {
            id: httpLabel
            anchors.centerIn: parent
            text: "HTTP"
            color: httpOption.selected ? root.themeUrgent : root.mutedFg
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: httpOption.selected
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: setupColumn.selectedTransport = "http"
          }
        }
      }

      Text {
        width: parent.width
        text: setupColumn.selectedTransport === "http"
          ? "HTTP sends the API key without encryption. Use only on a trusted network."
          : setupColumn.selectedAllowSelfSigned
            ? "HTTPS encrypts the API key, but certificate verification is disabled."
            : "HTTPS encrypts the API key in transit. Certificate verification is enabled by default."
        color: setupColumn.selectedTransport === "http" || setupColumn.selectedAllowSelfSigned ? root.themeUrgent : root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Rectangle {
        id: selfSignedToggle
        width: parent.width
        height: selfSignedLabel.implicitHeight + Style.space(14)
        radius: Style.space(4)
        opacity: setupColumn.selectedTransport === "https" ? 1 : 0.45
        color: selfSignedMouse.containsMouse && setupColumn.selectedTransport === "https"
          ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.12)
          : "transparent"

        Text {
          id: selfSignedLabel
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          text: setupColumn.selectedAllowSelfSigned ? "\u25CF Allow self-signed HTTPS certificate" : "\u25CB Verify HTTPS certificate"
          color: setupColumn.selectedAllowSelfSigned ? root.themeUrgent : root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          text: setupColumn.selectedAllowSelfSigned ? "ON" : "OFF"
          color: setupColumn.selectedAllowSelfSigned ? root.themeUrgent : root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        MouseArea {
          id: selfSignedMouse
          anchors.fill: parent
          enabled: setupColumn.selectedTransport === "https"
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: setupColumn.selectedAllowSelfSigned = !setupColumn.selectedAllowSelfSigned
        }
      }

      Text {
        text: "API KEY"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      TextField {
        id: keyField
        width: parent.width
        password: true
        placeholderText: "x-api-key value"
        foreground: root.fg
        font.family: root.fontFamily

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            setupColumn.commit()
            event.accepted = true
          } else if (event.key === Qt.Key_Escape) {
            root.close()
            event.accepted = true
          }
        }
      }

      Text {
        text: "POLL INTERVAL (SECONDS)"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      TextField {
        id: pollField
        width: parent.width
        placeholderText: "30"
        foreground: root.fg
        font.family: root.fontFamily
        inputMethodHints: Qt.ImhDigitsOnly

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            setupColumn.commit()
            event.accepted = true
          } else if (event.key === Qt.Key_Escape) {
            root.close()
            event.accepted = true
          }
        }
      }

      Row {
        spacing: Style.space(8)

        Button {
          text: "Save"

          onClicked: setupColumn.commit()
        }

        Button {
          text: "Cancel"
          bordered: true

          onClicked: root.setActive(0)
        }
      }

      Item {
        width: parent.width
        height: Style.space(6)
      }

      Text {
        text: "MANAGEMENT"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      Text {
        width: parent.width
        text: "Allow start/stop actions for containers, VMs, array, and parity checks from this panel."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }

      Rectangle {
        id: manageToggle

        width: parent.width
        height: manageLabel.implicitHeight + Style.space(14)
        radius: Style.space(4)
        color: manageMouse.containsMouse ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.12) : "transparent"

        Text {
          id: manageLabel
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          text: root.manageAllowed ? "\u25CF Management enabled" : "\u25CB Read-only"
          color: root.manageAllowed ? root.themeAccent : root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          text: root.manageAllowed ? "ON" : "OFF"
          color: root.manageAllowed ? root.themeAccent : root.mutedFg
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        MouseArea {
          id: manageMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: {
            if (!root.hostWidget || typeof root.hostWidget.saveSettings !== "function") return
            root.hostWidget.saveSettings({ manageMode: !root.hostWidget.manageMode })
            if (root.hostWidget.manageMode) root.fetchParityInfo()
          }
        }
      }

      Item {
        width: parent.width
        height: Style.space(6)
      }

      Text {
        text: "THEME"
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
      }

      Row {
        width: parent.width
        spacing: Style.space(6)

        Rectangle {
          readonly property bool selected: !root.unraidTheme

          width: (parent.width - parent.spacing) / 2
          height: themeLabelL.implicitHeight + Style.space(14)
          radius: Style.space(4)
          color: selected
            ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.18)
            : "transparent"
          border.width: 1
          border.color: selected ? root.themeAccent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)

          Text {
            id: themeLabelL
            anchors.centerIn: parent
            text: "\u25CF  Omarchy"
            color: parent.selected ? root.themeAccent : root.mutedFg
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: parent.selected
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              if (!root.hostWidget || typeof root.hostWidget.saveSettings !== "function") return
              if (root.hostWidget.unraidTheme) root.hostWidget.saveSettings({ themeMode: "omarchy" })
            }
          }
        }

        Rectangle {
          readonly property bool selected: root.unraidTheme

          width: (parent.width - parent.spacing) / 2
          height: themeLabelR.implicitHeight + Style.space(14)
          radius: Style.space(4)
          color: selected ? Qt.rgba(root.themeAccent.r, root.themeAccent.g, root.themeAccent.b, 0.18) : "transparent"
          border.width: 1
          border.color: selected ? root.themeAccent : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)

          Text {
            id: themeLabelR
            anchors.centerIn: parent
            text: "\u25CF  Unraid"
            color: parent.selected ? root.themeAccent : root.mutedFg
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: parent.selected
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              if (!root.hostWidget || typeof root.hostWidget.saveSettings !== "function") return
              if (!root.hostWidget.unraidTheme) root.hostWidget.saveSettings({ themeMode: "unraid" })
            }
          }
        }
      }

      Text {
        width: parent.width
        text: "Create a key under Settings \u2192 Management Access \u2192 API Keys on the Unraid server (Unraid 7.2+). The key is stored in ~/.config/omarchy/shell.json \u2014 use a least-privilege key."
        color: root.mutedFg
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }
  }
}
