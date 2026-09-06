.pragma library

var SUMMARY_QUERY = [
    "query UnraidSummary {",
    "  array {",
    "    state",
    "    disks { id name size status temp fsSize fsUsed fsFree }",
    "    caches { id name size status temp fsSize fsUsed fsFree }",
    "    parities { id name size status temp }",
    "  }",
    "  docker {",
    "    containers { id names state status autoStart }",
    "  }",
    "  vms {",
    "    domains { id name state }",
    "  }",
    "  metrics {",
    "    cpu { percentTotal cpus { percentTotal } }",
    "    memory { total used percentTotal swapTotal swapUsed percentSwapTotal }",
    "  }",
    "  info {",
    "    cpu { brand }",
    "    os { hostname }",
    "  }",
    "}"
].join("\n")

var PARITY_QUERY = [
    "query UnraidParityInfo {",
    "  array {",
    "    parityCheckStatus { status progress errors }",
    "  }",
    "  parityHistory { date duration errors status }",
    "  info {",
    "    os { uptime }",
    "  }",
    "}"
].join("\n")

var MAX_RESPONSE_BYTES = 1024 * 1024
var MAX_TEXT_LENGTH = 256
var MAX_LIST_ITEMS = 256
var MAX_CORE_ITEMS = 256
var MAX_HISTORY_ITEMS = 90

function boundedText(value, fallback, limit) {
    var text = value === undefined || value === null ? fallback : String(value)
    text = text.replace(/[\u0000-\u001f\u007f]/g, " ")
    text = text.replace(/</g, "[").replace(/>/g, "]")
    return text.length > limit ? text.slice(0, Math.max(0, limit - 3)) + "..." : text
}

function selectedTransport(serverUrl, transport) {
    var value = String(transport || "").toLowerCase()
    if (value === "http" || value === "https") return value
    return /^http:\/\//i.test(String(serverUrl || "")) ? "http" : "https"
}

function graphqlUrl(serverUrl, transport) {
    var url = String(serverUrl || "").trim()
    if (url === "") return ""
    if (url.length > 2048 || /[\u0000-\u0020\u007f]/.test(url)) return ""
    var scheme = selectedTransport(url, transport)
    var explicitScheme = url.match(/^([a-z][a-z0-9+.-]*):\/\//i)
    if (explicitScheme && explicitScheme[1].toLowerCase() !== "http" && explicitScheme[1].toLowerCase() !== "https") return ""
    if (explicitScheme) url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, scheme + "://")
    else url = scheme + "://" + url
    url = url.replace(/\/+$/, "")
    if (!/\/graphql$/.test(url)) url += "/graphql"
    return url
}

function requestArgs(serverUrl, apiKey, allowSelfSigned, transport) {
    var args = ["curl", "-sS", "--max-time", "8", "--max-filesize", String(MAX_RESPONSE_BYTES)]
    if (allowSelfSigned === true && selectedTransport(serverUrl, transport) === "https") args.push("-k")
    args.push("-H", "content-type: application/json")
    args.push("-H", "x-api-key: " + String(apiKey))
    args.push("--data-binary", JSON.stringify({ query: SUMMARY_QUERY }))
    args.push("-w", "\n%{http_code}")
    args.push(graphqlUrl(serverUrl, transport))
    return args
}

function parityRequestArgs(serverUrl, apiKey, allowSelfSigned, transport) {
    var args = ["curl", "-sS", "--max-time", "8", "--max-filesize", String(MAX_RESPONSE_BYTES)]
    if (allowSelfSigned === true && selectedTransport(serverUrl, transport) === "https") args.push("-k")
    args.push("-H", "content-type: application/json")
    args.push("-H", "x-api-key: " + String(apiKey))
    args.push("--data-binary", JSON.stringify({ query: PARITY_QUERY }))
    args.push("-w", "\n%{http_code}")
    args.push(graphqlUrl(serverUrl, transport))
    return args
}

function dashboardUrl(serverUrl, transport) {
    return graphqlUrl(serverUrl, transport).replace(/\/graphql$/, "")
}

function mutationArgs(serverUrl, apiKey, allowSelfSigned, queryText, transport) {
    var args = ["curl", "-sS", "--max-time", "20", "--max-filesize", String(MAX_RESPONSE_BYTES)]
    if (allowSelfSigned === true && selectedTransport(serverUrl, transport) === "https") args.push("-k")
    args.push("-H", "content-type: application/json")
    args.push("-H", "x-api-key: " + String(apiKey))
    args.push("--data-binary", JSON.stringify({ query: queryText }))
    args.push("-w", "\n%{http_code}")
    args.push(graphqlUrl(serverUrl, transport))
    return args
}

function httpErrorMessage(code, body, stderr) {
    if (code === "") {
        var detail = boundedText(String(stderr || "").replace(/\s+$/, "").split("\n").pop(), "", 140)
        return detail === "" ? "connection failed" : detail
    }
    if (code === "401") return "unauthorized \u2014 check the API key"
    if (code === "403") return "forbidden \u2014 check the key's roles"
    if (code === "404") return "endpoint not found \u2014 check the server URL"
    var snippet = boundedText(String(body || "").trim(), "", 120)
    return "HTTP " + code + (snippet === "" ? "" : ": " + snippet.slice(0, 120))
}

function numberOr(value) {
    var n = parseFloat(value)
    return isNaN(n) ? -1 : n
}

function parseSummary(raw, stderr) {
    var full = String(raw || "")
    if (full.length > MAX_RESPONSE_BYTES) return { ok: false, error: "response too large" }
    var code = ""
    var cut = full.lastIndexOf("\n")
    if (cut >= 0) {
        var tail = full.slice(cut + 1).trim()
        if (/^\d{3}$/.test(tail)) {
            code = tail
            full = full.slice(0, cut)
        }
    }

    var text = full.trim()
    if (code !== "" && code.charAt(0) !== "2")
        return { ok: false, error: httpErrorMessage(code, text, stderr) }
    if (text === "")
        return { ok: false, error: httpErrorMessage("", "", stderr) }

    var parsed
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        return { ok: false, error: "response was not valid JSON" }
    }

    if (!parsed || typeof parsed !== "object")
        return { ok: false, error: "response was not valid JSON" }

    if (!parsed.data) {
        var message = Array.isArray(parsed.errors) && parsed.errors.length > 0
            ? boundedText((parsed.errors[0] || {}).message || "GraphQL error", "GraphQL error", MAX_TEXT_LENGTH)
            : "GraphQL error"
        return { ok: false, error: message }
    }

    var data = parsed.data
    var array = data.array || {}
    var info = data.info || {}
    var system = mapSystem(data.metrics, info)

    return {
        ok: true,
        error: "",
        snapshot: {
            arrayState: boundedText(array.state || "UNKNOWN", "UNKNOWN", 32).toUpperCase(),
            disks: mapDisks(array.disks),
            caches: mapDisks(array.caches),
            parities: mapDisks(array.parities),
            containers: mapContainers((data.docker || {}).containers),
            vms: mapVms((data.vms || {}).domains),
            system: system
        }
    }
}

function mapDisks(disks) {
    var list = Array.isArray(disks) ? disks : []
    var out = []
    for (var i = 0; i < Math.min(list.length, MAX_LIST_ITEMS); i++) {
        var d = list[i] || {}
        var temp = d.temp === undefined || d.temp === null ? null : numberOr(d.temp)
        out.push({
            name: boundedText(d.name || "?", "?", MAX_TEXT_LENGTH),
            status: boundedText(d.status || "UNKNOWN", "UNKNOWN", 32).toUpperCase(),
            tempC: temp === null || temp < 0 ? null : temp,
            fsSize: numberOr(d.fsSize),
            fsUsed: numberOr(d.fsUsed),
            fsFree: numberOr(d.fsFree)
        })
    }
    return out
}

function diskUsedPercent(disk) {
    if (!disk) return null
    var used = disk.fsUsed
    var free = disk.fsFree
    if (used < 0 || free < 0 || (used + free) <= 0) return null
    return Math.min(100, Math.round(100 * used / (used + free)))
}

function humanSize(bytes) {
    var n = numberOr(bytes)
    if (n < 0) return "\u2013"
    var units = ["B", "K", "M", "G", "T", "P"]
    var u = 0
    while (n >= 1024 && u < units.length - 1) {
        n /= 1024
        u++
    }
    return (u === 0 ? String(n) : n.toFixed(n >= 10 ? 0 : 1)) + " " + units[u]
}

function hottestDisk(disks) {
    var hottest = null
    for (var i = 0; i < disks.length; i++) {
        var t = disks[i].tempC
        if (t !== null && (hottest === null || t > hottest)) hottest = t
    }
    return hottest
}

function parseParity(raw, stderr) {
    var full = String(raw || "")
    if (full.length > MAX_RESPONSE_BYTES) return { ok: false, error: "response too large" }
    var code = ""
    var cut = full.lastIndexOf("\n")
    if (cut >= 0) {
        var tail = full.slice(cut + 1).trim()
        if (/^\d{3}$/.test(tail)) {
            code = tail
            full = full.slice(0, cut)
        }
    }

    var text = full.trim()
    if (code !== "" && code.charAt(0) !== "2")
        return { ok: false, error: httpErrorMessage(code, text, stderr) }
    if (text === "")
        return { ok: false, error: httpErrorMessage("", "", stderr) }

    var parsed
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        return { ok: false, error: "response was not valid JSON" }
    }

    if (!parsed || typeof parsed !== "object")
        return { ok: false, error: "response was not valid JSON" }

    if (!parsed.data)
        return { ok: false, error: "GraphQL error" }

    var data = parsed.data
    var historyList = Array.isArray(data.parityHistory) ? data.parityHistory.slice(0, MAX_HISTORY_ITEMS) : []
    var history = historyList.filter(function(h) {
        return h && h.date && String(h.status).toUpperCase() === "COMPLETED" && Date.parse(h.date) > 0 && Date.parse(h.date) > 100000000000
    })
    var last = history.length > 0 ? history[0] : null
    var pcs = ((data.array || {}).parityCheckStatus) || {}
    var status = boundedText(pcs.status || "UNKNOWN", "UNKNOWN", 32).toUpperCase()

    return {
        ok: true,
        error: "",
        parity: {
            checkStatus: status === "NEVER_RUN" ? "NEVER RUN" : status,
            progress: pcs.progress !== null && pcs.progress !== undefined ? Number(pcs.progress) : null,
            errors: pcs.errors !== null && pcs.errors !== undefined ? Number(pcs.errors) : null,
            lastDate: last ? boundedText(last.date, "", MAX_TEXT_LENGTH) : null,
            lastDurationSec: last && last.duration !== null && last.duration !== undefined ? Number(last.duration) : null,
            lastErrors: last && last.errors !== null && last.errors !== undefined ? Number(last.errors) : null,
            bootTime: boundedText((((data.info || {}).os) || {}).uptime || "", "", MAX_TEXT_LENGTH)
        }
    }
}

function parseActionResult(raw, stderr) {
    var full = String(raw || "")
    if (full.length > MAX_RESPONSE_BYTES) return { ok: false, error: "response too large" }
    var code = ""
    var cut = full.lastIndexOf("\n")
    if (cut >= 0) {
        var tail = full.slice(cut + 1).trim()
        if (/^\d{3}$/.test(tail)) {
            code = tail
            full = full.slice(0, cut)
        }
    }

    var text = full.trim()
    if (code !== "" && code.charAt(0) !== "2")
        return { ok: false, error: httpErrorMessage(code, text, stderr) }
    if (text === "")
        return { ok: false, error: httpErrorMessage("", "", stderr) }

    var parsed
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        return { ok: false, error: "response was not valid JSON" }
    }

    if (!parsed || typeof parsed !== "object")
        return { ok: false, error: "response was not valid JSON" }

    if (!parsed.data && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        var message = boundedText((parsed.errors[0] || {}).message || "GraphQL error", "GraphQL error", MAX_TEXT_LENGTH)
        return { ok: false, error: message }
    }

    return { ok: true, error: "", data: parsed.data || {} }
}

function relativeTime(iso, nowMs) {
    var t = Date.parse(String(iso))
    if (isNaN(t)) return ""
    var diff = Math.max(0, ((nowMs || Date.now()) - t) / 1000)
    var units = [[31536000, "y"], [2592000, "mo"], [604800, "wk"], [86400, "d"], [3600, "h"], [60, "m"]]
    for (var i = 0; i < units.length; i++) {
        if (diff >= units[i][0]) return Math.floor(diff / units[i][0]) + " " + units[i][1] + " ago"
    }
    return "just now"
}

function uptimeHuman(bootIso, nowMs) {
    var t = Date.parse(String(bootIso))
    if (isNaN(t)) return ""
    var diff = Math.max(0, Math.floor(((nowMs || Date.now()) - t) / 1000))
    var d = Math.floor(diff / 86400)
    var h = Math.floor((diff % 86400) / 3600)
    var m = Math.floor((diff % 3600) / 60)
    if (d > 0) return d + "d " + h + "h"
    if (h > 0) return h + "h " + m + "m"
    return m + "m"
}

function mapSystem(metrics, info) {    var m = metrics || {}
    var cpu = m.cpu || null
    var mem = m.memory || null
    var os = (info && info.os) || {}
    var cpuInfo = (info && info.cpu) || {}
    return {
        cpuBrand: boundedText(cpuInfo.brand || "", "", MAX_TEXT_LENGTH).trim(),
        hostname: boundedText(os.hostname || "", "", MAX_TEXT_LENGTH).trim(),
        cpuPercent: cpu && cpu.percentTotal !== null && cpu.percentTotal !== undefined ? Math.round(cpu.percentTotal * 10) / 10 : null,
        cores: cpu && Array.isArray(cpu.cpus) ? cpu.cpus.slice(0, MAX_CORE_ITEMS).map(function(c) {
            return c && c.percentTotal !== null && c.percentTotal !== undefined ? Math.round(c.percentTotal) : 0
        }) : [],
        memTotal: mem && mem.total !== null && mem.total !== undefined ? Number(mem.total) : 0,
        memUsed: mem && mem.used !== null && mem.used !== undefined ? Number(mem.used) : 0,
        memPercent: mem && mem.percentTotal !== null && mem.percentTotal !== undefined ? Math.round(mem.percentTotal * 10) / 10 : null,
        swapTotal: mem && mem.swapTotal !== null && mem.swapTotal !== undefined ? Number(mem.swapTotal) : 0,
        swapUsed: mem && mem.swapUsed !== null && mem.swapUsed !== undefined ? Number(mem.swapUsed) : 0,
        swapPercent: mem && mem.percentSwapTotal !== null && mem.percentSwapTotal !== undefined ? Math.round(mem.percentSwapTotal * 10) / 10 : null
    }
}

function mapContainers(containers) {
    var list = Array.isArray(containers) ? containers : []
    var out = []
    for (var i = 0; i < Math.min(list.length, MAX_LIST_ITEMS); i++) {
        var c = list[i] || {}
        var names = Array.isArray(c.names) && c.names.length > 0 ? c.names : ["?"]
        out.push({
            id: boundedText(c.id || "", "", MAX_TEXT_LENGTH),
            name: boundedText(String(names[0]).replace(/^\//, ""), "?", MAX_TEXT_LENGTH),
            state: boundedText(c.state || "UNKNOWN", "UNKNOWN", 32).toUpperCase(),
            autoStart: c.autoStart === true
        })
    }
    return out
}

function mapVms(vms) {
    var list = Array.isArray(vms) ? vms : []
    var out = []
    for (var i = 0; i < Math.min(list.length, MAX_LIST_ITEMS); i++) {
        var vm = list[i] || {}
        out.push({
            id: boundedText(vm.id || "", "", MAX_TEXT_LENGTH),
            name: boundedText(vm.name || "?", "?", MAX_TEXT_LENGTH),
            state: boundedText(vm.state || "unknown", "unknown", 32).toLowerCase()
        })
    }
    return out
}

function diskOk(status) {
    return /^(DISK_OK|DISK_OK_NP|DISK_NP)/.test(String(status))
}

function containerRunning(state) {
    return String(state).toUpperCase() === "RUNNING"
}

function vmRunning(state) {
    return /running/i.test(String(state))
}

function shortStatus(status) {
    return String(status).replace(/^DISK_/, "")
}

function dockerCounts(containers) {
    var list = Array.isArray(containers) ? containers : []
    var count = Math.min(list.length, MAX_LIST_ITEMS)
    var running = 0
    for (var i = 0; i < count; i++)
        if (containerRunning(list[i].state)) running++
    return { running: running, total: count }
}

function vmCounts(vms) {
    var list = Array.isArray(vms) ? vms : []
    var count = Math.min(list.length, MAX_LIST_ITEMS)
    var running = 0
    for (var i = 0; i < count; i++)
        if (vmRunning(list[i].state)) running++
    return { running: running, total: count }
}

function statusLevel(snapshot) {
    if (!snapshot) return "waiting"
    var state = String(snapshot.arrayState || "")
    if (state !== "STARTED") return "stopped"
    var groups = [snapshot.disks, snapshot.caches, snapshot.parities]
    for (var g = 0; g < groups.length; g++) {
        var list = Array.isArray(groups[g]) ? groups[g] : []
        for (var i = 0; i < list.length; i++)
            if (!diskOk(list[i].status)) return "degraded"
    }
    return "ok"
}

function clampPollSeconds(value) {
    var n = parseInt(value, 10)
    if (isNaN(n)) return 30
    return Math.max(5, Math.min(600, n))
}

function summaryLine(configured, snapshot, lastError) {
    if (!configured) return "Unraid: not configured"
    if (lastError !== "") return "Unraid unreachable: " + lastError
    if (!snapshot) return "Unraid: waiting for first response"
    var parts = ["Array " + snapshot.arrayState]
    if (snapshot.arrayState === "STARTED") {
        var docker = dockerCounts(snapshot.containers)
        var vms = vmCounts(snapshot.vms)
        parts.push(docker.running + "/" + docker.total + " containers")
        parts.push(vms.running + "/" + vms.total + " VMs")
        var hot = hottestDisk((snapshot.disks || []).concat(snapshot.caches || []))
        if (hot !== null) parts.push(hot + "\u00B0C hottest")
    }
    return "Unraid \u00B7 " + parts.join(" \u00B7 ")
}

if (typeof module !== "undefined") {
    module.exports = {
        SUMMARY_QUERY: SUMMARY_QUERY,
        PARITY_QUERY: PARITY_QUERY,
        graphqlUrl: graphqlUrl,
        requestArgs: requestArgs,
        parityRequestArgs: parityRequestArgs,
        dashboardUrl: dashboardUrl,
        parseSummary: parseSummary,
        parseParity: parseParity,
        parseActionResult: parseActionResult,
        mutationArgs: mutationArgs,
        relativeTime: relativeTime,
        uptimeHuman: uptimeHuman,
        diskOk: diskOk,
        containerRunning: containerRunning,
        vmRunning: vmRunning,
        shortStatus: shortStatus,
        dockerCounts: dockerCounts,
        vmCounts: vmCounts,
        statusLevel: statusLevel,
        clampPollSeconds: clampPollSeconds,
        summaryLine: summaryLine,
        hottestDisk: hottestDisk,
        diskUsedPercent: diskUsedPercent,
        humanSize: humanSize,
        mapSystem: mapSystem,
        boundedText: boundedText,
        MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
        MAX_LIST_ITEMS: MAX_LIST_ITEMS
    }
}
