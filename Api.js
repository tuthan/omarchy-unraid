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

var DOCKER_LAUNCH_FIELDS_QUERY = [
    "query DockerLaunchFields {",
    "  __type(name: \"DockerContainer\") {",
    "    fields { name }",
    "  }",
    "}"
].join("\n")

// Literal allowlist: only these names may ever be added to the summary query.
var KNOWN_LAUNCH_FIELDS = ["webUiUrl", "lanIpPorts"]

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

function summaryQuery(fields) {
    // NOTE: builds the enhanced query by string surgery on SUMMARY_QUERY.
    // If the baseline query text is ever reordered, the containers-line
    // match below stops matching and the enhancement silently disappears;
    // tests/remote-console-access.test.cjs pins the exact baseline text.
    var selected = []
    if (Array.isArray(fields)) {
        for (var i = 0; i < fields.length; i++) {
            var f = String(fields[i] || "")
            if (KNOWN_LAUNCH_FIELDS.indexOf(f) !== -1 && selected.indexOf(f) === -1) selected.push(f)
        }
    }
    if (selected.length === 0) return SUMMARY_QUERY
    var lines = SUMMARY_QUERY.split("\n")
    var out = []
    for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("containers { id names state status autoStart }") !== -1) {
            // Optional selections extend the containers selection itself:
            // they belong to DockerContainer, not to the docker root type.
            out.push(lines[j].replace("autoStart }", "autoStart " + selected.join(" ") + " }"))
        } else {
            out.push(lines[j])
        }
    }
    return out.join("\n")
}

function requestArgs(serverUrl, apiKey, allowSelfSigned, transport, fields) {
    var args = ["curl", "-sS", "--max-time", "8", "--max-filesize", String(MAX_RESPONSE_BYTES)]
    if (allowSelfSigned === true && selectedTransport(serverUrl, transport) === "https") args.push("-k")
    args.push("-H", "content-type: application/json")
    args.push("-H", "x-api-key: " + String(apiKey))
    args.push("--data-binary", JSON.stringify({ query: summaryQuery(fields) }))
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

function discoveryRequestArgs(serverUrl, apiKey, allowSelfSigned, transport) {
    var args = ["curl", "-sS", "--max-time", "8", "--max-filesize", String(MAX_RESPONSE_BYTES)]
    if (allowSelfSigned === true && selectedTransport(serverUrl, transport) === "https") args.push("-k")
    args.push("-H", "content-type: application/json")
    args.push("-H", "x-api-key: " + String(apiKey))
    args.push("--data-binary", JSON.stringify({ query: DOCKER_LAUNCH_FIELDS_QUERY }))
    args.push("-w", "\n%{http_code}")
    args.push(graphqlUrl(serverUrl, transport))
    return args
}

// Identifies GraphQL failures caused by the optional launch fields (e.g.
// an older server build rejecting "webUiUrl" or a key lacking the role).
// Callers use this to downgrade to the baseline query once without touching
// unrelated monitoring errors.
function isOptionalFieldError(message) {
    var text = String(message || "")
    return text.indexOf("webUiUrl") !== -1 || text.indexOf("lanIpPorts") !== -1
}

function parseDockerLaunchFields(raw, stderr) {    // Discovery is best-effort: any failure yields an empty allowlisted field
    // set without touching monitoring's lastError.
    function unavailable() {
        return { ok: false, fields: [], error: "discovery unavailable" }
    }
    var full = String(raw || "")
    if (full.length > MAX_RESPONSE_BYTES) return unavailable()
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
    if (code !== "" && code.charAt(0) !== "2") return unavailable()
    if (text === "") return unavailable()

    var parsed
    try {
        parsed = JSON.parse(text)
    } catch (e) {
        return unavailable()
    }
    if (!parsed || typeof parsed !== "object" || !parsed.data) return unavailable()

    var type = parsed.data.__type
    if (!type || typeof type !== "object") return unavailable()
    var fieldList = type.fields
    if (!Array.isArray(fieldList)) return unavailable()

    var found = []
    for (var i = 0; i < fieldList.length; i++) {
        var entry = fieldList[i] || {}
        var name = typeof entry.name === "string" ? entry.name : ""
        // Never splice arbitrary server-returned names into GraphQL: keep
        // only the literal known names.
        if (KNOWN_LAUNCH_FIELDS.indexOf(name) !== -1 && found.indexOf(name) === -1) found.push(name)
    }
    return { ok: true, fields: found, error: "" }
}

function dashboardUrl(serverUrl, transport) {
    return graphqlUrl(serverUrl, transport).replace(/\/graphql$/, "")
}

// Pure, deliberately bounded URL parser used by launch validation. QML's JS
// runtime does not provide the global URL constructor, and this code must
// behave identically under Node's test harness, so parsing is implemented
// here instead of delegated to runtime globals.
var MAX_URL_LENGTH = 4096

function validateLaunchUrl(value) {
    function reject(reason) {
        return { ok: false, url: "", destination: "", error: reason }
    }

    if (typeof value !== "string") return reject("not a string")
    if (value.length < 1 || value.length > MAX_URL_LENGTH) return reject("invalid length")

    // Reject anything that is not plain printable ASCII; this excludes
    // whitespace, control characters, backslashes, and raw Unicode forms.
    if (!/^[\x21-\x7e]+$/.test(value)) return reject("invalid characters")
    if (/\\/.test(value)) return reject("invalid characters")

    var schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)
    if (!schemeMatch) return reject("not an absolute http(s) URL")
    var scheme = schemeMatch[1].toLowerCase()
    if (scheme !== "http" && scheme !== "https") return reject("unsupported scheme")

    // Authority runs to the first '/', '?', or '#'. Anything before the
    // scheme terminator is forbidden (user-info credentials).
    var rest = value.slice(schemeMatch[0].length)
    var authEnd = rest.length
    for (var i = 0; i < rest.length; i++) {
        var ch = rest.charAt(i)
        if (ch === "/" || ch === "?" || ch === "#") { authEnd = i; break }
    }
    var authority = rest.slice(0, authEnd)
    var pathAndMore = rest.slice(authEnd)

    if (authority === "") return reject("missing host")
    // User-info credentials are rejected outright.
    if (authority.indexOf("@") !== -1) return reject("credentials in URL")

    var hostPart = authority
    var portText = ""
    var explicitPort = 0

    if (authority.charAt(0) === "[") {
        // Bracketed IPv6: [::1] or [::1]:8080
        var close = authority.indexOf("]")
        if (close === -1) return reject("malformed IPv6 authority")
        hostPart = authority.slice(0, close + 1)
        portText = authority.slice(close + 1)
        if (portText !== "" && portText.charAt(0) !== ":") return reject("malformed IPv6 authority")
        var ipv6Body = authority.slice(1, close)
        if (!/^[0-9a-fA-F:.]+$/.test(ipv6Body)) return reject("malformed IPv6 address")
        if (!/^[0-9a-fA-F:]*:[0-9a-fA-F:]*$/.test(ipv6Body) || (ipv6Body.match(/:/g) || []).length < 2)
            return reject("malformed IPv6 address")
        if (/::/.test(ipv6Body.replace(/^::/, "::").replace(/::$/, "::")) && /::.*::/.test(ipv6Body))
            return reject("malformed IPv6 address")
        if ((ipv6Body.match(/::/g) || []).length > 1) return reject("malformed IPv6 address")
        hostPart = "[" + ipv6Body.toLowerCase() + "]"
        if (portText !== "") {
            portText = portText.slice(1)
            if (!/^\d{1,5}$/.test(portText)) return reject("invalid port")
            explicitPort = parseInt(portText, 10)
            if (explicitPort < 1 || explicitPort > 65535) return reject("invalid port")
        }
    } else {
        var colon = authority.lastIndexOf(":")
        if (colon !== -1) {
            hostPart = authority.slice(0, colon)
            portText = authority.slice(colon + 1)
            if (!/^\d{1,5}$/.test(portText)) return reject("invalid port")
            explicitPort = parseInt(portText, 10)
            if (explicitPort < 1 || explicitPort > 65535) return reject("invalid port")
        }
        if (hostPart === "") return reject("missing host")
        // IPv4 form: four decimal octets 0-255, no leading zeros longer than
        // one digit (e.g. "01" is tolerated only as written; strictness on
        // octet value is what matters).
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)) {
            var octets = hostPart.split(".")
            for (var o = 0; o < 4; o++) {
                var oct = parseInt(octets[o], 10)
                if (oct > 255) return reject("malformed IPv4 address")
            }
        } else {
            // DNS name: letters/digits/hyphen/dot labels, single-label LAN
            // hosts allowed. Malformed percent escapes cannot appear because
            // '%' is not in the accepted set.
            if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/.test(hostPart))
                return reject("malformed hostname")
        }
    }

    // Path/query/fragment must contain no malformed percent escapes.
    if (/%(?![0-9a-fA-F]{2})/.test(pathAndMore)) return reject("malformed percent escape")

    var defaultPort = scheme === "https" ? 443 : 80
    var displayPort = explicitPort !== 0 ? explicitPort : defaultPort
    var destination = hostPart + ":" + String(displayPort)

    return {
        ok: true,
        url: value,
        destination: destination,
        error: ""
    }
}

function unraidPageUrl(serverUrl, transport, page) {
    var pages = { Docker: "/Docker", VMs: "/VMs" }
    var suffix = pages[String(page)]
    if (suffix === undefined) return { ok: false, url: "", destination: "", error: "unknown page" }

    var raw = String(serverUrl || "").trim()
    if (raw === "") return { ok: false, url: "", destination: "", error: "server URL not configured" }
    // Use the configured transport only; unknown transports never construct
    // a page link.
    var selected = selectedTransport(raw, transport)
    if (selected !== "http" && selected !== "https") return { ok: false, url: "", destination: "", error: "unsupported transport" }
    if (String(transport || "").toLowerCase() !== selected && /:\/\//.test(raw) === false && String(transport || "") !== "")
        return { ok: false, url: "", destination: "", error: "unsupported transport" }

    // Reject ambiguous bases outright rather than constructing an
    // unexpected route.
    if (/[?#]/.test(raw)) return { ok: false, url: "", destination: "", error: "unsupported server URL" }

    // dashboardUrl() removes the terminal /graphql and preserves any
    // supported base path; normalize the joining slash, then validate the
    // final destination with the same strictness as launch URLs.
    var base = dashboardUrl(raw, transport)
    if (base === "") return { ok: false, url: "", destination: "", error: "invalid server URL" }
    base = base.replace(/\/+$/, "")

    var candidate = base + suffix
    var validated = validateLaunchUrl(candidate)
    if (!validated.ok) return { ok: false, url: "", destination: "", error: validated.error }
    return validated
}

// ---- VM console (VNC/SPICE) over read-only SSH discovery ----
//
// The Unraid GraphQL API does not expose VM graphics data at any build, and
// every webgui AJAX action that produces a console URL (domain-start-console
// and friends) starts the VM or writes files server-side. The graphics
// attributes of a RUNNING domain are instead available read-only via
// "virsh dumpxml --domain <uuid>", fetched over SSH with key auth. Ports
// change on every boot, so nothing is persisted.

var MAX_SSH_OUTPUT_BYTES = 1024 * 1024
var VM_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function validateVmUuid(value) {
    return typeof value === "string" && VM_UUID_PATTERN.test(value)
}

// The identity key is optional: when the dedicated plugin key is missing,
// ssh falls back to the agent/default identities.
function sshIdentityPath(homeDir) {
    var home = String(homeDir || "")
    if (home === "") return ""
    return home.replace(/\/+$/, "") + "/.ssh/id_ed25519_unraid"
}

function sshDiscoveryArgs(user, serverUrl, transport, domainUuid, homeDir) {
    var safeUser = String(user || "").trim()
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(safeUser)) return []
    var rawServer = String(serverUrl || "").trim()
    if (rawServer === "" || /[?#]/.test(rawServer)) return []
    var base = dashboardUrl(rawServer, transport)
    if (base === "") return []
    var validated = validateLaunchUrl(base)
    if (!validated.ok) return []
    // Authority host without the webgui port: ssh uses the SSH port
    // separately (default 22). Keep IPv6 brackets in the ssh target.
    var colon = validated.destination.lastIndexOf(":")
    var host = validated.destination.slice(0, colon)
    var authority = host.charAt(0) === "[" ? host : host.replace(/[[\]]/g, "")
    if (authority === "") return []

    if (!validateVmUuid(domainUuid)) return []

    var args = ["ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new"]
    var identity = sshIdentityPath(homeDir)
    if (identity !== "") {
        args.push("-o", "IdentitiesOnly=yes")
        args.push("-i", identity)
    }
    args.push(safeUser + "@" + authority)
    // Remote command is a single argv element for ssh; the uuid is validated
    // hex/dash only, so it cannot break out of the argument.
    args.push("virsh dumpxml --domain " + domainUuid)
    return args
}

// Parses the <graphics/> element of a running domain's XML. Returns
// { ok, protocol, port, wsPort, error }. Ports are host-side numbers
// (5900+/5700+); they only exist while the domain is running.
function parseDomainGraphics(raw) {
    function reject(reason) {
        return { ok: false, protocol: "", port: 0, wsPort: 0, error: reason }
    }
    var text = String(raw || "")
    if (text.length < 1 || text.length > MAX_SSH_OUTPUT_BYTES) return reject("invalid output size")
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return reject("control characters in output")

    var elements = text.match(/<graphics\b[^>]*\/?>/g)
    if (!elements) return reject("no graphics device")

    for (var i = 0; i < elements.length; i++) {
        var el = elements[i]
        var type = xmlAttr(el, "type")
        if (type !== "vnc" && type !== "spice") continue
        var port = parseInt(xmlAttr(el, "port"), 10)
        if (isNaN(port) || port < 1 || port > 65535) continue // autoport not allocated (stopped domain)
        var wsPort = parseInt(xmlAttr(el, "websocket"), 10)
        var password = xmlAttr(el, "passwd")
        return {
            ok: true,
            protocol: type,
            port: port,
            wsPort: isNaN(wsPort) || wsPort < 1 || wsPort > 65535 ? 0 : wsPort,
            hasPassword: typeof password === "string" && password.length > 0,
            error: ""
        }
    }
    return reject("no usable graphics port")
}

function xmlAttr(element, name) {
    var m = element.match(new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')"))
    if (!m) return ""
    return m[2] !== undefined ? m[2] : m[3]
}

// Host:port authority exactly like PHP's HTTP_HOST for the webgui's noVNC
// client: bare hostname on default ports, hostname:port otherwise.
function webguiHost(serverUrl, transport) {
    var base = dashboardUrl(serverUrl, transport)
    var validated = validateLaunchUrl(base)
    if (!validated.ok) return ""
    var colon = validated.destination.lastIndexOf(":")
    var host = validated.destination.slice(0, colon)
    var port = validated.destination.slice(colon + 1)
    var scheme = /^https:/.test(base) ? "https" : "http"
    var isDefault = (scheme === "https" && port === "443") || (scheme === "http" && port === "80")
    return isDefault ? host : host + ":" + port
}

// Builds the exact console URL the Unraid webgui builds (VMajax.php
// domain-start-console), but without any mutation: the websocket proxy route
// is served by the webgui on 80/443 and needs only the user's normal
// browser login.
function vmConsoleUrl(serverUrl, transport, graphics, vmName) {
    if (!graphics || !graphics.ok) return { ok: false, url: "", destination: "", error: "console not available" }
    var base = dashboardUrl(serverUrl, transport).replace(/\/+$/, "")
    if (base === "") return { ok: false, url: "", destination: "", error: "invalid server URL" }
    if (/[?#]/.test(base)) return { ok: false, url: "", destination: "", error: "unsupported server URL" }
    var host = webguiHost(serverUrl, transport)
    if (host === "") return { ok: false, url: "", destination: "", error: "invalid server URL" }

    var page = graphics.protocol === "spice" ? "spice.html" : "vnc.html"
    var candidate = base + "/plugins/dynamix.vm.manager/" + page +
        "?autoconnect=true&host=" + encodeURIComponent(host)
    if (graphics.protocol === "spice") {
        candidate += "&vmname=" + encodeURIComponent(String(vmName || "").slice(0, 128)) +
            "&port=/wsproxy/" + graphics.port + "/"
    } else {
        if (graphics.wsPort < 1) return { ok: false, url: "", destination: "", error: "no websocket port" }
        candidate += "&port=&path=/wsproxy/" + graphics.wsPort + "/&resize=scale"
    }

    var validated = validateLaunchUrl(candidate)
    if (!validated.ok) return { ok: false, url: "", destination: "", error: validated.error }
    return validated
}

// ---- Favorites ----
//
// Pinned containers sort to the top of the Docker list. Favorites persist
// as container NAMES (stable across image updates; container ids change on
// recreate). The list is an explicit user-managed array — never
// auto-created — capped and name-bounded for storage safety.

var MAX_FAVORITES = 32

// Returns a new list: pinned containers first (in favorites order),
// everything else after in its original order. Unknown favorite names are
// simply ignored until a container with that name appears.
function sortContainersWithFavorites(containers, favorites) {
    var list = Array.isArray(containers) ? containers.slice() : []
    var favs = allowlistedFavorites(favorites)

    var pinned = []
    var rest = []
    for (var i = 0; i < list.length; i++) {
        var c = list[i] || {}
        var name = typeof c.name === "string" ? c.name : ""
        if (name !== "" && favs.indexOf(name) !== -1) pinned.push(c)
        else rest.push(c)
    }
    pinned.sort(function(a, b) {
        return favs.indexOf(a.name) - favs.indexOf(b.name)
    })
    return pinned.concat(rest)
}

function allowlistedFavorites(favorites) {
    var out = []
    var list = Array.isArray(favorites) ? favorites : []
    for (var i = 0; i < list.length; i++) {
        var name = typeof list[i] === "string" ? list[i] : ""
        if (name !== "" && out.indexOf(name) === -1 && out.length < MAX_FAVORITES) out.push(name)
    }
    return out
}

// Adds or removes a name; returns a fresh array (never mutates the input).
function toggleFavoriteName(favorites, name) {
    var target = String(name || "")
    if (target === "") return allowlistedFavorites(favorites)
    var current = Array.isArray(favorites) ? favorites : []
    var exists = current.indexOf(target) !== -1
    var out = []
    for (var i = 0; i < current.length; i++) {
        if (typeof current[i] === "string" && current[i] !== target && out.length < MAX_FAVORITES)
            out.push(current[i])
    }
    if (!exists && out.length < MAX_FAVORITES) out.push(target)
    return out
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
        // Launch metadata is optional: an invalid value clears the action but
        // must never discard an otherwise valid container row.
        var launch = validateLaunchUrl(typeof c.webUiUrl === "string" ? c.webUiUrl : "")
        var ports = []
        if (Array.isArray(c.lanIpPorts)) {
            for (var p = 0; p < Math.min(c.lanIpPorts.length, 8); p++) {
                var entry = c.lanIpPorts[p]
                if (typeof entry !== "string" || entry === "") continue
                // Display-only strings; never used to construct launch URLs.
                ports.push(boundedText(entry, "", 128))
            }
        }
        out.push({
            id: boundedText(c.id || "", "", MAX_TEXT_LENGTH),
            name: boundedText(String(names[0]).replace(/^\//, ""), "?", MAX_TEXT_LENGTH),
            state: boundedText(c.state || "UNKNOWN", "UNKNOWN", 32).toUpperCase(),
            autoStart: c.autoStart === true,
            webUiUrl: launch.ok ? launch.url : "",
            webUiDestination: launch.ok ? launch.destination : "",
            publishedPorts: ports
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
        DOCKER_LAUNCH_FIELDS_QUERY: DOCKER_LAUNCH_FIELDS_QUERY,
        PARITY_QUERY: PARITY_QUERY,
        graphqlUrl: graphqlUrl,
        requestArgs: requestArgs,
        summaryQuery: summaryQuery,
        discoveryRequestArgs: discoveryRequestArgs,
        parseDockerLaunchFields: parseDockerLaunchFields,
        isOptionalFieldError: isOptionalFieldError,
        parityRequestArgs: parityRequestArgs,
        dashboardUrl: dashboardUrl,
        validateLaunchUrl: validateLaunchUrl,
        unraidPageUrl: unraidPageUrl,
        validateVmUuid: validateVmUuid,
        sshDiscoveryArgs: sshDiscoveryArgs,
        sshIdentityPath: sshIdentityPath,
        parseDomainGraphics: parseDomainGraphics,
        vmConsoleUrl: vmConsoleUrl,
        webguiHost: webguiHost,
        sortContainersWithFavorites: sortContainersWithFavorites,
        allowlistedFavorites: allowlistedFavorites,
        toggleFavoriteName: toggleFavoriteName,
        MAX_FAVORITES: MAX_FAVORITES,
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
