/**
 * Sub-Store 脚本: Gemini 可用性检测 v4（支持 Web 检测 + 严格/模式开关；两次尝试后放弃、可锁定仅用缓存）
 *
 *
 * 1) 增加 Gemini Web 探测（默认 https://gemini.google.com/app?hl=en），并加入“阻断页/风控页/地区不可用”特征识别，降低假阳性。
 * 2) 引入 mode / strict 开关：
 *    - mode=api_only | web_only | api_then_web（默认 api_then_web）
 *    - strict=1（默认）时：API 必须 400 且错误 JSON 合理；Web 必须状态符合且未命中阻断特征；302 Location 需合理
 *      strict=0 时：Web 只看状态码；API 只看 400（更宽松）
 * 3) 保留：maxTries（单节点最多尝试次数）/ maxRuns（同批次最多检测轮次后锁定仅用缓存）/ force（强制重测）
 * 4) 保留：香港节点名称正则直接排除逻辑（hkRegex）
 *
 * 参数：
 * - mode: 探测模式（默认 api_then_web）
 *      * api_only      : 只测 API（generativelanguage.googleapis.com）
 *      * web_only      : 只测 Web（gemini.google.com）
 *      * api_then_web  : 先测 API，失败再测 Web（默认）
 * - strict: 'true'|'1' 开启严格（默认 true）
 * - web_url: Web 探测 URL（默认 https://gemini.google.com/app?hl=en）
 * - web_ok_statuses: Web 视为可达的 HTTP 状态码（默认 200,302）
 * - concurrency / timeout / rename / prefix / cache / maxTries / maxRuns / force 同之前
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge } = $.env;

  const concurrency = parseInt($arguments.concurrency || 10);
  const requestTimeout = parseInt($arguments.timeout || 5000);
  const enableRename = $arguments.rename === "true";

  const GLOBAL_TIMEOUT = 28000;
  const prefixStr = $arguments.prefix ?? "[Gemini] ";

  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15...ebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const mode = ($arguments.mode || "api_then_web").toLowerCase(); // api_only | web_only | api_then_web
  const strict =
    $arguments.strict === undefined
      ? true
      : $arguments.strict === "true" || $arguments.strict === "1";

  // API 探测：无效 key 触发 400
  const apiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro?key=InvalidKey";

  // Web 探测：更贴近真实“网页 Gemini”
  const webUrl = $arguments.web_url || "https://gemini.google.com/app?hl=en";
  const webOkStatuses = parseStatusList(
    $arguments.web_ok_statuses || "200,302",
  );

  const hkRegex = /(?:HongKong|Hong Kong|HK|🇭🇰|香\s*港|港中转)/i;

  const useCache = $arguments.cache !== "false";
  const force =
    ($arguments.force === "true" || $arguments.force === "1") && useCache;

  const maxTries = parseInt($arguments.maxTries ?? $arguments.max_tries ?? 2);
  const maxRuns = parseInt($arguments.maxRuns ?? $arguments.max_runs ?? 2);

  const cache = scriptResourceCache;
  const target = isLoon ? "Loon" : isSurge ? "Surge" : undefined;

  const startTime = Date.now();
  const deadline = startTime + GLOBAL_TIMEOUT;
  const tasks = [];

  // --- 0) 批次 key（用于“最多检测两轮后锁定仅用缓存”） ---
  const batchKey = getBatchKey(proxies);
  let batchMeta = (useCache ? cache.get(batchKey) : undefined) || {
    runs: 0,
    locked: false,
  };

  const shouldLock =
    useCache &&
    !force &&
    maxRuns > 0 &&
    (batchMeta.locked === true || batchMeta.runs >= maxRuns);

  if (shouldLock) {
    for (const proxy of proxies) {
      const cacheKey = getProxyCacheKey(proxy);
      const cachedRes = cache.get(cacheKey);
      if (cachedRes && cachedRes.ok === true) {
        proxy._isOk = true;
        if (enableRename) addPrefix(proxy);
      } else {
        proxy._isOk = false;
      }
    }
    return proxies.filter((p) => p._isOk === true);
  }

  // --- 1) 读缓存 + 组装检测任务 ---
  for (const proxy of proxies) {
    const cacheKey = getProxyCacheKey(proxy);
    proxy._cacheKey = cacheKey;

    let cachedRes = undefined;
    if (useCache) cachedRes = cache.get(cacheKey);

    if (cachedRes && cachedRes.ok === true) {
      proxy._isOk = true;
      if (enableRename) addPrefix(proxy);
      continue;
    }

    const tries =
      cachedRes && typeof cachedRes.tries === "number" ? cachedRes.tries : 0;
    if (!force && maxTries > 0 && tries >= maxTries) {
      proxy._isOk = false;
      continue;
    }

    tasks.push({ proxy, cacheKey, tries });
  }

  // --- 2) 执行检测 ---
  let attemptedCount = 0;
  if (tasks.length > 0) {
    await executeAsyncTasks(
      tasks.map((task) => async () => {
        if (Date.now() > deadline) return;

        // 香港节点直接排除（并写入失败尝试次数，避免后续再次进入检测队列）
        if (hkRegex.test(task.proxy.name || "")) {
          task.proxy._isOk = false;
          if (useCache) {
            const nextTries = (task.tries || 0) + 1;
            cache.set(task.cacheKey, {
              ok: false,
              tries: nextTries,
              ts: Date.now(),
            });
          }
          return;
        }

        const node = ProxyUtils.produce([task.proxy], target);
        if (!node) return;

        attemptedCount++;
        const isOk = await checkGemini(node, requestTimeout);

        if (useCache) {
          const nextTries = (task.tries || 0) + 1;
          cache.set(task.cacheKey, {
            ok: !!isOk,
            tries: nextTries,
            ts: Date.now(),
          });
        }

        task.proxy._isOk = !!isOk;
        if (enableRename && isOk) addPrefix(task.proxy);
      }),
      { concurrency, deadline },
    );
  }

  // --- 3) 更新批次轮次：达到 maxRuns 后锁定，仅用缓存 ---
  if (useCache && !force && maxRuns > 0 && attemptedCount > 0) {
    const nextRuns =
      (typeof batchMeta.runs === "number" ? batchMeta.runs : 0) + 1;
    batchMeta = { runs: nextRuns, locked: nextRuns >= maxRuns, ts: Date.now() };
    cache.set(batchKey, batchMeta);
  }

  return proxies.filter((p) => p._isOk === true);

  // --- 辅助函数 ---

  function addPrefix(proxy) {
    if (!proxy.name.includes(prefixStr)) {
      proxy.name = prefixStr + proxy.name;
    }
  }

  function getProxyCacheKey(proxy) {
    const fingerprint = getFingerprint(proxy);
    return `gemini_check_standalone_v4:${fingerprint}`;
  }

  function getBatchKey(proxies) {
    const fps = proxies.map((p) => getFingerprint(p)).sort();
    const h = hashStrings(fps);
    return `gemini_check_batch_v2:${h}`;
  }

  function hashStrings(list) {
    let h = 5381;
    for (const s of list) {
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
        h = h >>> 0;
      }
    }
    return (h >>> 0).toString(16);
  }

  async function checkGemini(node, timeout) {
    if (mode === "api_only") return await checkGeminiAPI(node, timeout);
    if (mode === "web_only") return await checkGeminiWeb(node, timeout);

    // api_then_web（默认）
    const apiOk = await checkGeminiAPI(node, timeout);
    if (apiOk) return true;
    return await checkGeminiWeb(node, timeout);
  }

  async function checkGeminiAPI(node, timeout) {
    try {
      const res = await $.http.get({
        url: apiUrl,
        headers: { "User-Agent": UA, Accept: "application/json" },
        node,
        timeout,
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      const body = (res.body ?? res.rawBody ?? "") + "";

      if (status !== 400) return false;
      if (!strict) return true;

      // 严格：返回体需是 Google API 标准错误 JSON
      try {
        const j = JSON.parse(body);
        if (j && j.error && (j.error.code === 400 || j.error.status))
          return true;
      } catch (e) {
        /* ignore */
      }

      if (/api key/i.test(body) && /not valid|invalid/i.test(body)) return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  async function checkGeminiWeb(node, timeout) {
    try {
      const res = await $.http.get({
        url: webUrl,
        headers: {
          "User-Agent": UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
        },
        node,
        timeout,
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      const headers = res.headers || {};
      const body = ((res.body ?? res.rawBody ?? "") + "").slice(0, 200000);

      if (!webOkStatuses.has(status)) return false;
      if (!strict) return true;

      if (looksLikeBlockedGoogle(body)) return false;

      if (status === 302) {
        const loc = getHeader(headers, "location");
        if (!loc) return true;
        if (/google\.com\/sorry/i.test(loc) || /\/sorry\b/i.test(loc))
          return false;
        if (
          /accounts\.google\.com/i.test(loc) ||
          /consent\.google\.com/i.test(loc)
        )
          return true;
        return true;
      }

      if (/Sign in/i.test(body) && /Google Accounts/i.test(body)) return true;
      if (/\bGemini\b/i.test(body) || /\bBard\b/i.test(body)) return true;

      return true;
    } catch (e) {
      return false;
    }
  }

  function looksLikeBlockedGoogle(body) {
    const b = body || "";
    const patterns = [
      /Our systems have detected unusual traffic/i,
      /unusual traffic from your computer network/i,
      /To continue, please verify/i,
      /www\.google\.com\/sorry/i,
      /\bAccess denied\b/i,
      /\bForbidden\b/i,
      /This service is not available/i,
      /isn[’']t available in your country/i,
      /not available in your country/i,
      /not supported in your region/i,
      /isn[’']t available in your region/i,
      /无法在您所在的国家\/地区使用/,
      /该服务在您所在的国家\/地区不可用/,
      /不适用于您所在的国家\/地区/,
      /此服务目前无法使用/,
    ];
    return patterns.some((re) => re.test(b));
  }

  function getHeader(headers, name) {
    const n = (name || "").toLowerCase();
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase() === n) return headers[k];
    }
    return "";
  }

  function getFingerprint(proxy) {
    const entries = Object.entries(proxy)
      .filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(Object.fromEntries(entries));
  }

  function executeAsyncTasks(tasks, { concurrency = 1, deadline } = {}) {
    return new Promise((resolve) => {
      let running = 0;
      let index = 0;
      function executeNextTask() {
        if (deadline && Date.now() > deadline)
          return running === 0 ? resolve() : null;
        while (index < tasks.length && running < concurrency) {
          const currentTask = tasks[index++];
          running++;
          Promise.resolve()
            .then(currentTask)
            .catch(() => {})
            .finally(() => {
              running--;
              if (running === 0 && index >= tasks.length) return resolve();
              executeNextTask();
            });
        }
        if (running === 0 && index >= tasks.length) resolve();
      }
      executeNextTask();
    });
  }

  function parseStatusList(s) {
    const set = new Set();
    (s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => {
        const n = parseInt(x);
        if (!isNaN(n)) set.add(n);
      });
    if (set.size === 0) {
      set.add(200);
      set.add(302);
    }
    return set;
  }
}
