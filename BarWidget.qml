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
  readonly property string transport: {
    var configuredTransport = String(setting("transport", "")).toLowerCase()
    if (configuredTransport === "http" || configuredTransport === "https") return configuredTransport
    return /^http:\/\//i.test(serverUrl) ? "http" : "https"
  }
  readonly property bool allowSelfSigned: setting("allowSelfSigned", false) === true
  readonly property int pollSeconds: Api.clampPollSeconds(setting("pollSeconds", 30))

  readonly property bool configured: serverUrl !== "" && apiKey !== ""
  readonly property bool manageMode: setting("manageMode", false) === true

  // VM console over read-only SSH discovery (opt-in). Ports are fetched per
  // click and never persisted; virsh dumpxml never mutates the server.
  readonly property bool sshConsole: setting("sshConsole", false) === true
  readonly property string sshUser: String(setting("sshUser", "root"))

  // Explicit user-managed favorites (container names); pinned rows sort to
  // the top of the Docker list.
  readonly property var favoriteNames: Api.allowlistedFavorites(setting("dockerFavorites", null))

  property var snapshot: null
  property string lastError: ""

  // Connection-generation bookkeeping: guards async results from applying
  // across configuration changes. Process bookkeeping only — no persistent
  // capability cache.
  property int configGeneration: 0
  property int probeAttemptedGeneration: -1
  property var launchFields: []
  property int summaryGeneration: -1
  property int discoveryGeneration: -1
  property bool pendingSummaryRefresh: false
  property bool pendingProbe: false

  // One summary process and one discovery process at a time; captured
  // generation on each process keeps stale output inert.
  function refresh() {
    if (!configured) return
    if (proc.running) {
      pendingSummaryRefresh = true
      return
    }
    summaryGeneration = configGeneration
    proc.command = Api.requestArgs(serverUrl, apiKey, allowSelfSigned, transport, launchFields)
    proc.running = true
  }

  function startDiscovery() {
    if (!configured) return
    if (probeAttemptedGeneration === configGeneration) return
    if (discoveryProc.running) {
      // Prior-generation process still draining: queue this generation's
      // attempt until it exits. Not marked attempted yet.
      pendingProbe = true
      return
    }
    // Mark attempted before launching: a timeout, denial, or parse failure
    // completes this generation's attempt; ordinary refresh never retries.
    probeAttemptedGeneration = configGeneration
    discoveryGeneration = configGeneration
    discoveryProc.command = Api.discoveryRequestArgs(serverUrl, apiKey, allowSelfSigned, transport)
    discoveryProc.running = true
  }

  // Coalesce connection-property changes into one next-turn reset so a
  // Setup save cannot create multiple probes for intermediate values.
  function scheduleConfigReset() {
    configResetQueued = true
    Qt.callLater(applyConfigReset)
  }
  property bool configResetQueued: false
  function applyConfigReset() {
    if (!configResetQueued) return
    configResetQueued = false
    resetConnectionState()
  }

  function resetConnectionState() {
    configGeneration++
    launchFields = []
    probeAttemptedGeneration = -1
    pendingSummaryRefresh = false
    pendingProbe = false
    summaryGeneration = -1
    discoveryGeneration = -1
    // Clear the previous server's snapshot and error so its destinations
    // cannot remain clickable under the new configuration.
    snapshot = null
    lastError = ""
    if (configured) {
      Qt.callLater(refresh)
      Qt.callLater(startDiscovery)
    }
  }

  onServerUrlChanged: scheduleConfigReset()
  onApiKeyChanged: scheduleConfigReset()
  onTransportChanged: scheduleConfigReset()
  onAllowSelfSignedChanged: scheduleConfigReset()

  readonly property string statusLevel: !configured ? "unconfigured"
    : lastError !== "" ? "error"
    : Api.statusLevel(snapshot)

  readonly property var dockerCounts: snapshot ? Api.dockerCounts(snapshot.containers) : { running: 0, total: 0 }
  readonly property bool unraidTheme: setting("themeMode", "unraid") !== "omarchy"
  readonly property color themeAccent: unraidTheme ? "#EE7F3C" : Color.accent
  readonly property color themeUrgent: unraidTheme ? "#D64541" : Color.urgent

  readonly property color statusColor: statusLevel === "ok" ? themeAccent
    : (statusLevel === "degraded" || statusLevel === "error") ? themeUrgent
    : Color.muted

  function saveSettings(values) {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    for (var next in values) entry[next] = values[next]
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
    // Connection-property change handlers coalesce the reset; an explicit
    // call here is unnecessary and would double-probe.
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
    onTriggered: {
      root.refresh()
      // One-shot probe per active connection configuration per widget
      // lifetime; ordinary poll ticks never retry a completed attempt.
      root.startDiscovery()
    }
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
      // Discard stale output first; the captured generation is immutable.
      if (summaryGeneration !== configGeneration) {
        root.drainQueuedWork()
        return
      }
      var result = Api.parseSummary(collector.text, errCollector.text)
      if (result.ok) {
        root.snapshot = result.snapshot
        root.lastError = ""
      } else if (root.launchFields.length > 0 && Api.isOptionalFieldError(result.error)) {
        // Identifiable optional-field validation/permission failure that
        // invalidates monitoring: downgrade to the baseline query for this
        // generation and queue one baseline summary. Never re-probes and
        // never oscillates between enhanced and baseline queries.
        root.launchFields = []
        root.pendingSummaryRefresh = true
      } else {
        root.lastError = result.error
      }
      root.drainQueuedWork()
    }
  }

  function drainQueuedWork() {
    if (root.pendingSummaryRefresh) {
      root.pendingSummaryRefresh = false
      Qt.callLater(root.refresh)
    }
    if (root.pendingProbe) {
      root.pendingProbe = false
      Qt.callLater(root.startDiscovery)
    }
  }

  Process {
    id: discoveryProc

    stdout: StdioCollector { id: discoveryCollector; waitForEnd: true }
    stderr: StdioCollector { id: discoveryErrCollector; waitForEnd: true }

    onExited: {
      if (discoveryGeneration !== configGeneration) {
        root.drainQueuedWork()
        return
      }
      var result = Api.parseDockerLaunchFields(discoveryCollector.text, discoveryErrCollector.text)
      // Any failure completes the attempt with an empty field set; baseline
      // monitoring continues and lastError is untouched.
      if (result.ok && result.fields.length > 0) {
        root.launchFields = result.fields
        // Current-generation successful probe: request a summary refresh
        // carrying the new fields (queued if proc is busy).
        root.refresh()
      }
      root.drainQueuedWork()
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
        opacity: root.configured ? 1 : 0.4

        Behavior on opacity { NumberAnimation { duration: 160 } }
      }

      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.configured
        width: Style.space(6)
        height: width
        radius: width / 2
        color: Color.muted
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
