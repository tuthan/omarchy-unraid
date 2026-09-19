// Focused checks for the remote-console-access helpers in Api.js.
// Run: node --test tests/remote-console-access.test.cjs
//
// Api.js is a QML .pragma library; only its leading pragma line is removed
// before loading it as CommonJS. Node-only behavior here is not QML
// validation — see the plan's verification matrix.

const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const src = fs.readFileSync(path.join(__dirname, "..", "Api.js"), "utf8")
const loadable = src.replace(/^\s*\.pragma library\s*\n/, "")
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omarchy-unraid-api-")), "api-under-test.cjs")
fs.writeFileSync(tmp, loadable)
const Api = require(tmp)

test("discovery: both optional fields accepted, unknown names excluded", () => {
  const raw = JSON.stringify({
    data: { __type: { fields: [{ name: "webUiUrl" }, { name: "lanIpPorts" }, { name: "evilField" }] } }
  })
  const result = Api.parseDockerLaunchFields(raw, "")
  assert.equal(result.ok, true)
  assert.deepEqual(result.fields, ["webUiUrl", "lanIpPorts"])
})

test("discovery: either field alone", () => {
  const one = Api.parseDockerLaunchFields(JSON.stringify({ data: { __type: { fields: [{ name: "webUiUrl" }] } } }), "")
  assert.deepEqual(one.fields, ["webUiUrl"])
  const other = Api.parseDockerLaunchFields(JSON.stringify({ data: { __type: { fields: [{ name: "lanIpPorts" }] } } }), "")
  assert.deepEqual(other.fields, ["lanIpPorts"])
})

test("discovery: neither field present", () => {
  const result = Api.parseDockerLaunchFields(JSON.stringify({ data: { __type: { fields: [{ name: "id" }] } } }), "")
  assert.equal(result.ok, true)
  assert.deepEqual(result.fields, [])
})

test("discovery: denied/timeout/empty response is unavailable", () => {
  for (const raw of ["", "401\nUnauthorized", "not json"]) {
    const result = Api.parseDockerLaunchFields(raw, "curl: (28) timeout")
    assert.equal(result.ok, false)
    assert.deepEqual(result.fields, [])
    assert.notEqual(result.error, "")
  }
})

test("discovery: GraphQL error, missing type, malformed field list", () => {
  const gqlErr = Api.parseDockerLaunchFields(JSON.stringify({ errors: [{ message: "denied" }] }), "")
  assert.equal(gqlErr.ok, false)
  const noType = Api.parseDockerLaunchFields(JSON.stringify({ data: {} }), "")
  assert.equal(noType.ok, false)
  const malformed = Api.parseDockerLaunchFields(JSON.stringify({ data: { __type: { fields: "nope" } } }), "")
  assert.equal(malformed.ok, false)
  const nullEntry = Api.parseDockerLaunchFields(JSON.stringify({ data: { __type: { fields: [null, {}] } } }), "")
  assert.equal(nullErrSafe(nullEntry), true)
  function nullErrSafe(r) { return r.ok === true && Array.isArray(r.fields) }
})

test("discovery: non-string names ignored", () => {
  const raw = JSON.stringify({ data: { __type: { fields: [{ name: 42 }, "webUiUrl", { name: "lanIpPorts" }] } } })
  const result = Api.parseDockerLaunchFields(raw, "")
  assert.deepEqual(result.fields, ["lanIpPorts"])
})

test("query composition: omitted/empty fields produce exact baseline", () => {
  assert.equal(Api.summaryQuery(undefined), Api.SUMMARY_QUERY)
  assert.equal(Api.summaryQuery(null), Api.SUMMARY_QUERY)
  assert.equal(Api.summaryQuery([]), Api.SUMMARY_QUERY)
  assert.equal(Api.summaryQuery(["unknown"]), Api.SUMMARY_QUERY)
})

test("query composition: allowlisted fields added once, others retained, no tailscale", () => {
  const q = Api.summaryQuery(["webUiUrl", "lanIpPorts"])
  assert.ok(q.includes("containers { id names state status autoStart webUiUrl lanIpPorts }"))
  assert.equal((q.match(/webUiUrl/g) || []).length, 1)
  for (const kept of ["state", "disks { id name", "domains { id name state }", "percentTotal", "hostname"]) {
    assert.ok(q.includes(kept), "retains " + kept)
  }
  assert.ok(!/tailscale/i.test(q))
  const single = Api.summaryQuery(["lanIpPorts"])
  assert.ok(single.includes("containers { id names state status autoStart lanIpPorts }"))
  assert.ok(!single.includes("webUiUrl"))
  const baseline = Api.requestArgs("tower", "key", false, "https")
  assert.equal(JSON.parse(baseline[baseline.indexOf("--data-binary") + 1]).query, Api.SUMMARY_QUERY)
  const enhanced = Api.requestArgs("tower", "key", false, "https", ["webUiUrl", "lanIpPorts"])
  assert.equal(JSON.parse(enhanced[enhanced.indexOf("--data-binary") + 1]).query, q)
})

test("mapping: valid webUiUrl and destination; missing/null/invalid cleared", () => {
  const raw = JSON.stringify({
    data: {
      docker: {
        containers: [
          { id: "1", names: ["valid"], state: "RUNNING", autoStart: true, webUiUrl: "http://tower:8080/ui?k=1" },
          { id: "2", names: ["missing"], state: "EXITED" },
          { id: "3", names: ["null"], state: "EXITED", webUiUrl: null },
          { id: "4", names: ["invalid"], state: "RUNNING", webUiUrl: "javascript:alert(1)" }
        ]
      }
    }
  })
  const s = Api.parseSummary(raw, "")
  const [v, m, n, i] = s.snapshot.containers
  assert.equal(v.webUiUrl, "http://tower:8080/ui?k=1")
  assert.equal(v.webUiDestination, "tower:8080")
  assert.equal(m.webUiUrl, "")
  assert.equal(m.webUiDestination, "")
  assert.equal(n.webUiUrl, "")
  assert.equal(i.webUiUrl, "")
  assert.equal(i.state, "RUNNING")
})

test("mapping: oversized URL rejected without truncation", () => {
  const big = "http://h/" + "a".repeat(5000)
  const s = Api.parseSummary(JSON.stringify({ data: { docker: { containers: [{ id: "1", names: ["x"], state: "RUNNING", webUiUrl: big }] } } }), "")
  assert.equal(s.snapshot.containers[0].webUiUrl, "")
})

test("mapping: published ports are display-only, never launch URLs", () => {
  const s = Api.parseSummary(JSON.stringify({
    data: { docker: { containers: [{ id: "1", names: ["x"], state: "RUNNING", lanIpPorts: ["172.16.0.1:8080", "", 7, "y".repeat(200)] }] } }
  }), "")
  const c = s.snapshot.containers[0]
  // Bounded display strings; overlong entries are elided for display only.
  assert.deepEqual(c.publishedPorts, ["172.16.0.1:8080", "y".repeat(125) + "..."])
  assert.equal(c.webUiUrl, "")
  assert.equal(c.webUiDestination, "")
})

test("accepted URLs: hosts, ports, path/query/fragment preserved exactly", () => {
  const cases = [
    "http://tower.local:8080/",
    "http://tower",
    "https://myserver.lan/app",
    "http://192.168.1.10:8443/ui",
    "https://[fd00::10]:8443/console",
    "http://host:8080",
    "https://host:443/x"
  ]
  for (const c of cases) {
    const r = Api.validateLaunchUrl(c)
    assert.equal(r.ok, true, c)
    assert.equal(r.url, c, "exact bytes retained for " + c)
    assert.notEqual(r.destination, "")
  }
  const tricky = "http://tower:8080/?a=1&b=%2F;c=%22x%22&d=%27y%27&e=f&g=%20#top"
  const r = Api.validateLaunchUrl(tricky)
  assert.equal(r.ok, true)
  assert.equal(r.url, tricky)
  assert.equal(r.destination, "tower:8080")
})

test("accepted URLs: effective port 80/443 when absent, IPv6 bracketed destination", () => {
  assert.equal(Api.validateLaunchUrl("http://host").destination, "host:80")
  assert.equal(Api.validateLaunchUrl("https://host").destination, "host:443")
  assert.equal(Api.validateLaunchUrl("https://[fd00::10]:8443/").destination, "[fd00::10]:8443")
})

test("rejected URLs", () => {
  const rejected = [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "//host/path",
    "/relative",
    "http://user:pass@host/",
    "http://host with space/",
    "http://host/\rx",
    "http://host/\\path",
    "http://host/%zz/",
    "http://host/%zzb%20c/",
    "http://host/%2z%20/",
    "http://host:%zz/",
    "http://host:abc/",
    "http://host:0/",
    "http://host:70000/",
    "http://host:99999/",
    "http://[::zzzz]/",
    "http://[::1",
    "http://[::1]x/",
    "http://[::1]:0/",
    "http:///path",
    42,
    null,
    "http://host/".slice(0, 0) + "x".repeat(4097),
    "https://ex\u00e4mple.lan/"
  ]
  for (const c of rejected) {
    const r = Api.validateLaunchUrl(c)
    assert.equal(r.ok, false, JSON.stringify(c))
    assert.equal(r.url, "")
  }
  // A mixed valid+malformed escape set must still reject.
  assert.equal(Api.validateLaunchUrl("http://h/a%20b%zz").ok, false)
})

test("page composition: base forms, ports, trailing slash, /graphql, base path", () => {
  const cases = [
    ["tower.local", "https", "https://tower.local/Docker"],
    ["tower.local/", "https", "https://tower.local/Docker"],
    ["http://tower.local", "http", "http://tower.local/Docker"],
    ["192.168.1.10:8443", "https", "https://192.168.1.10:8443/Docker"],
    ["tower.local/graphql", "https", "https://tower.local/Docker"],
    ["tower.local/graphql/", "https", "https://tower.local/Docker"],
    ["tower.local/myunraid", "https", "https://tower.local/myunraid/Docker"]
  ]
  for (const [base, transport, expected] of cases) {
    const r = Api.unraidPageUrl(base, transport, "Docker")
    assert.equal(r.ok, true, base)
    assert.equal(r.url, expected)
  }
  const vms = Api.unraidPageUrl("tower.local", "https", "VMs")
  assert.equal(vms.url, "https://tower.local/VMs")
})

test("page composition: invalid page/base rejected", () => {
  assert.equal(Api.unraidPageUrl("tower.local", "https", "Terminal").ok, false)
  assert.equal(Api.unraidPageUrl("", "https", "Docker").ok, false)
  assert.equal(Api.unraidPageUrl("tower.local?q=1", "https", "Docker").ok, false)
  assert.equal(Api.unraidPageUrl("user:pass@tower.local", "https", "Docker").ok, false)
  assert.equal(Api.unraidPageUrl("tower.local", "ftp", "Docker").ok, false)
})

test("optional errors: identifiable fatal optional-field error is detectable, baseline errors are not", () => {
  assert.equal(Api.isOptionalFieldError('Cannot query field "webUiUrl" on type "DockerContainer".'), true)
  assert.equal(Api.isOptionalFieldError("unauthorized \u2014 check the API key"), false)
  assert.equal(Api.isOptionalFieldError("connection failed"), false)
})

test("optional errors: monitoring data preserved when launch metadata fails validation", () => {
  const raw = JSON.stringify({
    data: {
      array: { state: "STARTED", disks: [{ id: "d1", name: "disk1", status: "DISK_OK" }] },
      docker: { containers: [{ id: "1", names: ["x"], state: "RUNNING", webUiUrl: "javascript:x" }] },
      vms: { domains: [] },
      metrics: { cpu: { percentTotal: 5, cpus: [] }, memory: { total: 1, used: 0, percentTotal: 0 } },
      info: { os: { hostname: "tower" } }
    }
  })
  const s = Api.parseSummary(raw, "")
  assert.equal(s.ok, true)
  assert.equal(s.snapshot.arrayState, "STARTED")
  assert.equal(s.snapshot.disks.length, 1)
  assert.equal(s.snapshot.containers[0].webUiUrl, "")
})

// ---- VM console over read-only SSH discovery ----

test("vm uuid validation", () => {
  assert.equal(Api.validateVmUuid("27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2"), true)
  assert.equal(Api.validateVmUuid("27ff0cd0cb1b5c70c6ae204d38a20dd2"), false)
  assert.equal(Api.validateVmUuid("not-a-uuid"), false)
  assert.equal(Api.validateVmUuid("27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2; rm -rf /"), false)
  assert.equal(Api.validateVmUuid(null), false)
  assert.equal(Api.validateVmUuid(undefined), false)
})

test("ssh args: fixed argv, no shell, validated user/uuid/host", () => {
  const args = Api.sshDiscoveryArgs("root", "192.168.199.46", "http", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", "/home/me")
  assert.deepEqual(args, [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    "-i", "/home/me/.ssh/id_ed25519_unraid",
    "root@192.168.199.46",
    "virsh dumpxml --domain 27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2"
  ])
})

test("ssh args: rejects bad users, bad urls, bad uuids; supports nonstandard webgui port", () => {
  assert.deepEqual(Api.sshDiscoveryArgs("ro ot", "192.168.199.46", "http", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", ""), [])
  assert.deepEqual(Api.sshDiscoveryArgs("root; rm", "192.168.199.46", "http", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", ""), [])
  assert.deepEqual(Api.sshDiscoveryArgs("root", "", "http", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", ""), [])
  assert.deepEqual(Api.sshDiscoveryArgs("root", "x?q=1", "https", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", ""), [])
  assert.deepEqual(Api.sshDiscoveryArgs("root", "192.168.199.46", "http", "evil", "/home/me"), [])
  const ported = Api.sshDiscoveryArgs("root", "192.168.199.46:8443", "https", "27ff0cd0-cb1b-5c70-c6ae-204d38a20dd2", "")
  assert.equal(ported[ported.length - 2], "root@192.168.199.46")
})

test("ssh identity path: home handling", () => {
  assert.equal(Api.sshIdentityPath("/home/me"), "/home/me/.ssh/id_ed25519_unraid")
  assert.equal(Api.sshIdentityPath("/home/me/"), "/home/me/.ssh/id_ed25519_unraid")
  assert.equal(Api.sshIdentityPath(""), "")
})

test("domain graphics: running vnc domain with websocket", () => {
  const xml = "<domain type='kvm'><devices>" +
    "<graphics type='vnc' port='5901' autoport='yes' listen='0.0.0.0' websocket='5701' keymap='en-us'/>" +
    "</devices></domain>"
  const g = Api.parseDomainGraphics(xml)
  assert.equal(g.ok, true)
  assert.equal(g.protocol, "vnc")
  assert.equal(g.port, 5901)
  assert.equal(g.wsPort, 5701)
  assert.equal(g.hasPassword, false)
})

test("domain graphics: spice keeps main port, ignores rdp/others, picks first usable", () => {
  const spice = Api.parseDomainGraphics("<graphics type='spice' port='5900' tlsPort='-1' autoport='yes' websocket='5700'/>")
  assert.equal(spice.protocol, "spice")
  assert.equal(spice.port, 5900)
  const rdp = Api.parseDomainGraphics("<graphics type='rdp' port='3389'/>")
  assert.equal(rdp.ok, false)
  const stopped = Api.parseDomainGraphics("<graphics type='vnc' port='-1' autoport='yes'/>")
  assert.equal(stopped.ok, false)
  const multi = Api.parseDomainGraphics(
    "<graphics type='rdp' port='1'/><graphics type='spice' port='5902' websocket='5702'/><graphics type='vnc' port='-1'/>")
  assert.equal(multi.protocol, "spice")
  assert.equal(multi.port, 5902)
})

test("domain graphics: password attribute detected; malformed output rejected", () => {
  const withPw = Api.parseDomainGraphics("<graphics type='vnc' port='5900' websocket='5700' passwd='secret'/>")
  assert.equal(withPw.hasPassword, true)
  assert.equal(Api.parseDomainGraphics("").ok, false)
  assert.equal(Api.parseDomainGraphics("not xml at all").ok, false)
  assert.equal(Api.parseDomainGraphics("<graphics type='vnc' port='5900' websocket='5700'>".repeat(200000)).ok, false)
  const noXml = "x".repeat(2000000)
  assert.equal(Api.parseDomainGraphics(noXml).ok, false)
})

test("console url: vnc via websocket proxy route, exact webgui shape", () => {
  const g = { ok: true, protocol: "vnc", port: 5900, wsPort: 5700, hasPassword: false, error: "" }
  const r = Api.vmConsoleUrl("192.168.199.46", "http", g, "ClawBot")
  assert.equal(r.ok, true)
  assert.equal(r.url,
    "http://192.168.199.46/plugins/dynamix.vm.manager/vnc.html?autoconnect=true&host=192.168.199.46&port=&path=/wsproxy/5700/&resize=scale")
})

test("console url: https default port bare host; nonstandard port in host param; base path preserved", () => {
  const g = { ok: true, protocol: "vnc", port: 5900, wsPort: 5700, hasPassword: false, error: "" }
  assert.equal(Api.vmConsoleUrl("tower.local", "https", g, "x").url,
    "https://tower.local/plugins/dynamix.vm.manager/vnc.html?autoconnect=true&host=tower.local&port=&path=/wsproxy/5700/&resize=scale")
  const r8443 = Api.vmConsoleUrl("tower.local:8443", "https", g, "x")
  assert.ok(r8443.url.includes("host=tower.local%3A8443"))
  const rBase = Api.vmConsoleUrl("tower.local/myunraid", "https", g, "x")
  assert.ok(rBase.url.startsWith("https://tower.local/myunraid/plugins/dynamix.vm.manager/vnc.html"))
})

test("console url: spice uses main port through wsproxy and encodes vmname", () => {
  const g = { ok: true, protocol: "spice", port: 5902, wsPort: 5702, hasPassword: false, error: "" }
  const r = Api.vmConsoleUrl("192.168.199.46", "http", g, "My VM")
  assert.equal(r.url,
    "http://192.168.199.46/plugins/dynamix.vm.manager/spice.html?autoconnect=true&host=192.168.199.46&vmname=My%20VM&port=/wsproxy/5902/")
})

test("console url: vnc without websocket port rejected; no graphics rejected", () => {
  const g = { ok: true, protocol: "vnc", port: 5900, wsPort: 0, hasPassword: false, error: "" }
  assert.equal(Api.vmConsoleUrl("tower.local", "https", g, "x").ok, false)
  assert.equal(Api.vmConsoleUrl("tower.local", "https", null, "x").ok, false)
  assert.equal(Api.vmConsoleUrl("", "https", g, "x").ok, false)
  assert.equal(Api.vmConsoleUrl("tower.local?q=1", "https", g, "x").ok, false)
})

test("webgui host: PHP HTTP_HOST parity", () => {
  assert.equal(Api.webguiHost("tower.local", "https"), "tower.local")
  assert.equal(Api.webguiHost("http://tower.local", "http"), "tower.local")
  assert.equal(Api.webguiHost("tower.local:8443", "https"), "tower.local:8443")
  assert.equal(Api.webguiHost("tower.local:8080", "http"), "tower.local:8080")
})

// ---- Favorites ----

test("favorites: pinned containers first, in favorites order; rest keep original order", () => {
  const cons = [
    { name: "alpha", state: "RUNNING" },
    { name: "bravo", state: "RUNNING" },
    { name: "charlie", state: "EXITED" },
    { name: "delta", state: "RUNNING" }
  ]
  const sorted = Api.sortContainersWithFavorites(cons, ["charlie", "delta"])
  assert.deepEqual(sorted.map(c => c.name), ["charlie", "delta", "alpha", "bravo"])
  // Input never mutated
  assert.deepEqual(cons.map(c => c.name), ["alpha", "bravo", "charlie", "delta"])
})

test("favorites: unknown names ignored; no favorites = original order; null-safe", () => {
  const cons = [{ name: "a" }, { name: "b" }]
  assert.deepEqual(Api.sortContainersWithFavorites(cons, ["ghost"]).map(c => c.name), ["a", "b"])
  assert.deepEqual(Api.sortContainersWithFavorites(cons, null).map(c => c.name), ["a", "b"])
  assert.deepEqual(Api.sortContainersWithFavorites(null, ["a"]), [])
  assert.deepEqual(Api.sortContainersWithFavorites(cons, [42, "b"]).map(c => c.name), ["b", "a"])
})

test("favorites: toggle adds, removes, dedupes, and caps", () => {
  assert.deepEqual(Api.toggleFavoriteName([], "x"), ["x"])
  assert.deepEqual(Api.toggleFavoriteName(["x"], "x"), [])
  assert.deepEqual(Api.toggleFavoriteName(["a", "b"], "c"), ["a", "b", "c"])
  assert.deepEqual(Api.toggleFavoriteName(["a", "b", "c"], "b"), ["a", "c"])
  assert.deepEqual(Api.toggleFavoriteName(null, "x"), ["x"])
  // An empty name never wipes existing favorites.
  assert.deepEqual(Api.toggleFavoriteName(["a"], ""), ["a"])
  const many = Array.from({ length: 40 }, (_, i) => "c" + i)
  assert.equal(Api.toggleFavoriteName(many, "new").length, Api.MAX_FAVORITES)
  const favs = Api.allowlistedFavorites(["a", "a", 42, "b"])
  assert.deepEqual(favs, ["a", "b"])
  assert.equal(Api.allowlistedFavorites(Array.from({ length: 40 }, (_, i) => "f" + i)).length, Api.MAX_FAVORITES)
})
