import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Api.js" as Api

BarWidget {
  id: root
  moduleName: "io.github.hvo.omarchy-unraid"

  readonly property string serverUrl: String(setting("serverUrl", "")).replace(/\s+/g, "")
  readonly property string apiKey: String(setting("apiKey", ""))
  readonly property bool allowSelfSigned: setting("allowSelfSigned", true) === true
  readonly property int pollSeconds: Api.clampPollSeconds(setting("pollSeconds", 30))

  readonly property bool configured: serverUrl !== "" && apiKey !== ""
  readonly property bool manageMode: setting("manageMode", false) === true

  property var snapshot: null
  property string lastError: ""

  readonly property string statusLevel: !configured ? "unconfigured"
    : lastError !== "" ? "error"
    : Api.statusLevel(snapshot)

  readonly property var dockerCounts: snapshot ? Api.dockerCounts(snapshot.containers) : { running: 0, total: 0 }
  readonly property bool unraidTheme: setting("themeMode", "omarchy") === "unraid"
  readonly property color themeAccent: unraidTheme ? "#EE7F3C" : Color.accent
  readonly property color themeUrgent: unraidTheme ? "#D64541" : Color.urgent

  readonly property color statusColor: statusLevel === "ok" ? themeAccent
    : (statusLevel === "degraded" || statusLevel === "error") ? themeUrgent
    : Color.muted

  function refresh() {
    if (!configured) return
    if (proc.running) return
    proc.command = Api.requestArgs(serverUrl, apiKey, allowSelfSigned)
    proc.running = true
  }

  function saveSettings(values) {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    for (var next in values) entry[next] = values[next]
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
    Qt.callLater(root.refresh)
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Timer {
    interval: root.pollSeconds * 1000
    running: root.configured
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: proc

    stdout: StdioCollector {
      id: collector
      waitForEnd: true
    }

    stderr: StdioCollector {
      id: errCollector
      waitForEnd: true
    }

    onExited: {
      var result = Api.parseSummary(collector.text, errCollector.text)
      if (result.ok) {
        root.snapshot = result.snapshot
        root.lastError = ""
      } else {
        root.lastError = result.error
      }
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false

    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.hvo.omarchy-unraid"

    function refresh() { root.broadcast("refresh") }
    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.togglePanel() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: pillRow.implicitWidth + Style.space(14)
    tooltipText: Api.summaryLine(root.configured, root.snapshot, root.lastError)

    onPressed: function(b) {
      if (b === Qt.LeftButton) root.togglePanel()
    }

    Row {
      id: pillRow

      anchors.centerIn: parent
      spacing: Style.space(5)

      Image {
        anchors.verticalCenter: parent.verticalCenter
        source: Qt.resolvedUrl("assets/unraid-mark.png")
        sourceSize.width: Style.space(15)
        sourceSize.height: Style.space(15)
        fillMode: Image.PreserveAspectFit
        smooth: true
        visible: root.configured
        opacity: root.configured ? 1 : 0.4
      }

      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.configured && root.statusLevel !== "ok"
        width: Style.space(6)
        height: width
        radius: width / 2
        color: root.statusColor
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.dockerCounts.running > 0
        text: String(root.dockerCounts.running)
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
    }
  }
}
