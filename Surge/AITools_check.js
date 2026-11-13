/*
 * AITools_check.js — Surge generic script / Information Panel
 *
 * Sends lightweight HEAD requests through the AITools policy group to the
 * main AI endpoints, plus one exit-IP lookup, and reports the result.
 *
 * Reading the result:
 *   ✓  an HTTP answer came back (200-499 except 403/429): path is open
 *   ⚠  403 / 429 / 5xx: reached the site, but it answered with a block,
 *      challenge or error — often a region or exit-IP issue, not a dead node
 *   ✗  no answer (timeout / TLS / DNS failure): node or network problem
 *
 * Install: put this file next to AITools.sgmodule (iCloud Drive/Surge on iOS,
 * the Surge config folder on macOS). Panels are iOS-only; on macOS run the
 * script from the script editor and read the log.
 */
const POLICY = "AITools";
const TIMEOUT = 8; // seconds per request
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const TARGETS = [
  ["Claude", "https://claude.ai/"],
  ["Anthropic API", "https://api.anthropic.com/"],
  ["ChatGPT", "https://chatgpt.com/"],
  ["OpenAI API", "https://api.openai.com/"],
  ["Gemini", "https://gemini.google.com/"],
  ["NotebookLM", "https://notebooklm.google.com/"],
  ["Meta AI", "https://www.meta.ai/"],
  ["Siri / Apple AI", "https://guzzoni.apple.com/"],
];

function probe(name, url) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    $httpClient.head(
      { url: url, timeout: TIMEOUT, policy: POLICY, headers: { "User-Agent": UA } },
      function (err, resp) {
        const ms = Date.now() - t0;
        if (err || !resp) {
          resolve({ name: name, level: 2, line: "✗ " + name + "  no answer" });
          return;
        }
        const code = resp.status;
        const warn = code === 403 || code === 429 || code >= 500;
        resolve({
          name: name,
          level: warn ? 1 : 0,
          line: (warn ? "⚠ " : "✓ ") + name + "  " + code + "  " + ms + "ms",
        });
      }
    );
  });
}

function exitInfo() {
  return new Promise(function (resolve) {
    $httpClient.get(
      { url: "http://ip-api.com/json/?fields=status,countryCode,query", timeout: TIMEOUT, policy: POLICY },
      function (err, resp, data) {
        try {
          const j = JSON.parse(data);
          resolve(j.status === "success" ? j.countryCode + " " + j.query : "unknown");
        } catch (e) {
          resolve("unknown");
        }
      }
    );
  });
}

Promise.all([exitInfo()].concat(TARGETS.map(function (t) { return probe(t[0], t[1]); })))
  .then(function (res) {
    const exit = res[0];
    const rows = res.slice(1);
    const worst = Math.max.apply(null, rows.map(function (r) { return r.level; }));
    const cc = exit.split(" ")[0];
    const body = "Exit " + exit + "\n" + rows.map(function (r) { return r.line; }).join("\n");
    console.log(body);
    $done({
      title: "AI Tools · exit " + cc,
      content: body,
      icon: worst === 0 ? "sparkles" : "exclamationmark.triangle",
      "icon-color": worst === 0 ? "#336FA9" : (worst === 1 ? "#E0A030" : "#D65C51"),
    });
  })
  .catch(function (e) {
    console.log("AITools_check failed: " + e);
    $done({ title: "AI Tools", content: "Check failed: " + e, icon: "xmark.seal.fill", "icon-color": "#D65C51" });
  });
// [Script]
// http-response ^https?:\/\/m\.poizon\.com\/client\/init script-path=https://github.com/ConnersHua/Profiles/raw/master/Surge/Script/com.poizon.js,requires-body=true
// [MITM]
// hostname = m.poizon.com

let result = JSON.parse(body);

delete result.data.boot;
delete result.data.bootAnimation;

JSON.stringify(result);
