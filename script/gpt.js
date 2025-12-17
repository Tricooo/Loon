/**
 * Sub-Store 脚本: GPT / ChatGPT（OpenAI）可用性检测（可选严格模式 + 多种探测模式）
 *
 * 修复点：
 * - 将 Web 探测默认 URL 改为 https://chatgpt.com/?model=auto（更贴近你实际访问路径）。
 *   避免“根域 200/302 但 /?model=auto 返回 403（封控）”造成的假阳性。
 *
 * 核心能力：
 * 1) API 优先探测（更贴近 AI 能力调用链路）：GET https://api.openai.com/v1/models
 *    - 使用无效 Authorization 触发 401（严格模式下必须满足）
 * 2) Web 探测（可选）：GET https://chatgpt.com/?model=auto（可通过参数自定义）
 * 3) 每个节点最多尝试 maxTries 次；失败达到次数后“放弃”（后续不再重测）
 * 4) 同一批节点列表最多执行 maxRuns 轮检测；达到轮次后“锁定仅用缓存”（后续预览/更新不再检测，直接用缓存 ok=true）
 *
 * 参数：
 * - mode: 探测模式（默认 api_then_web）
 *      * api_only      : 只测 OpenAI API（最严格、最贴近“API 可用性”）
 *      * web_only      : 只测 ChatGPT Web（适合只关心网页访问）
 *      * api_then_web  : 先测 API，失败再测 Web（折中）
 * - strict: 是否严格判定（默认 true）
 *      * strict=true  : API 必须返回 401 且 body 可解析为 JSON（更严格、降低假阳性）
 *      * strict=false : API 主要接受 401；仍默认不接受 403/429（可通过 allow_403/allow_429 放宽）
 * - allow_403: 是否允许 API 的 403 作为“可达”（默认 false，不建议开启）
 * - allow_429: 是否允许 API 的 429 作为“可达”（默认 false，不建议开启）
 * - web_url: Web 探测 URL（默认 https://chatgpt.com/?model=auto）
 * - web_ok_statuses: Web 视为可达的 HTTP 状态码（默认 200,302）
 * - concurrency: 并发数，默认 10
 * - timeout: 单次请求超时(ms)，默认 5000
 * - rename: 'true'|'false'，通过的节点加前缀（默认 false）
 * - prefix: 前缀字符串，默认 '[GPT] '
 * - cache: 'false' 禁用缓存（默认启用）
 * - maxTries/max_tries: 单节点最大尝试次数，默认 2
 * - maxRuns/max_runs: 同批次最大检测轮次，默认 2
 * - force: 'true'|'1' 强制忽略锁定/放弃标记重新检测（需 cache 启用）
 * - deny: 可选，按节点名称正则排除（例如 'HK|香港'）
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge } = $.env;

  const concurrency = parseInt($arguments.concurrency || 10);
  const requestTimeout = parseInt($arguments.timeout || 5000);
  const enableRename = ($arguments.rename === 'true');

  const GLOBAL_TIMEOUT = 28000;
  const prefixStr = $arguments.prefix ?? '[GPT] ';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15...ebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const mode = ($arguments.mode || 'api_then_web').toLowerCase(); // api_only | web_only | api_then_web
  const strict = ($arguments.strict === undefined) ? true : ($arguments.strict === 'true' || $arguments.strict === '1');

  const allow403 = ($arguments.allow_403 === 'true' || $arguments.allow_403 === '1') ? true : false;
  const allow429 = ($arguments.allow_429 === 'true' || $arguments.allow_429 === '1') ? true : false;

  const apiUrl = 'https://api.openai.com/v1/models';

  // 修复：默认用 /?model=auto，避免根域可达但该路径 403 的假阳性
  const webUrl = $arguments.web_url || 'https://chatgpt.com/?model=auto';
  const webOkStatuses = parseStatusList($arguments.web_ok_statuses || '200,302');

  const useCache = $arguments.cache !== 'false';
  const force = ($arguments.force === 'true' || $arguments.force === '1') && useCache;

  const maxTries = parseInt($arguments.maxTries ?? $arguments.max_tries ?? 2);
  const maxRuns = parseInt($arguments.maxRuns ?? $arguments.max_runs ?? 2);

  const denyRe = compileDenyRegex($arguments.deny);

  const cache = scriptResourceCache;
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined;

  const startTime = Date.now();
  const deadline = startTime + GLOBAL_TIMEOUT;
  const tasks = [];

  // --- 0) 批次 key（用于“最多检测两轮后锁定仅用缓存”） ---
  const batchKey = getBatchKey(proxies);
  let batchMeta = (useCache ? cache.get(batchKey) : undefined) || { runs: 0, locked: false };

  const shouldLock = useCache && !force && maxRuns > 0 && (batchMeta.locked === true || batchMeta.runs >= maxRuns);

  // 已锁定：仅用缓存 ok=true，完全跳过检测
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
    return proxies.filter(p => p._isOk === true);
  }

  // --- 1) 读缓存 + 组装检测任务 ---
  for (const proxy of proxies) {
    const cacheKey = getProxyCacheKey(proxy);
    proxy._cacheKey = cacheKey;

    // deny 名称过滤：直接判失败，同时写入 tries（避免重复进队列）
    if (!force && denyRe && denyRe.test(proxy.name || '')) {
      proxy._isOk = false;
      if (useCache) {
        const cached = cache.get(cacheKey) || {};
        const nextTries = (typeof cached.tries === 'number' ? cached.tries : 0) + 1;
        cache.set(cacheKey, { ok: false, tries: nextTries, ts: Date.now(), denied: true });
      }
      continue;
    }

    let cachedRes = undefined;
    if (useCache) cachedRes = cache.get(cacheKey);

    if (cachedRes && cachedRes.ok === true) {
      proxy._isOk = true;
      if (enableRename) addPrefix(proxy);
      continue;
    }

    const tries = (cachedRes && typeof cachedRes.tries === 'number') ? cachedRes.tries : 0;
    if (!force && maxTries > 0 && tries >= maxTries) {
      // 达到最大尝试次数：放弃
      proxy._isOk = false;
      continue;
    }

    tasks.push({ proxy, cacheKey, tries });
  }

  // --- 2) 执行检测 ---
  let attemptedCount = 0;
  if (tasks.length > 0) {
    await executeAsyncTasks(
      tasks.map(task => async () => {
        if (Date.now() > deadline) return;

        const node = ProxyUtils.produce([task.proxy], target);
        if (!node) return;

        attemptedCount++;
        const isOk = await checkGPT(node, requestTimeout);

        if (useCache) {
          const nextTries = (task.tries || 0) + 1;
          cache.set(task.cacheKey, { ok: !!isOk, tries: nextTries, ts: Date.now() });
        }

        task.proxy._isOk = !!isOk;
        if (enableRename && isOk) addPrefix(task.proxy);
      }),
      { concurrency, deadline }
    );
  }

  // --- 3) 更新批次轮次：达到 maxRuns 后锁定，仅用缓存 ---
  if (useCache && !force && maxRuns > 0 && attemptedCount > 0) {
    const nextRuns = (typeof batchMeta.runs === 'number' ? batchMeta.runs : 0) + 1;
    batchMeta = { runs: nextRuns, locked: nextRuns >= maxRuns, ts: Date.now() };
    cache.set(batchKey, batchMeta);
  }

  return proxies.filter(p => p._isOk === true);

  // --- 探测逻辑 ---

  async function checkGPT(node, timeout) {
    if (mode === 'web_only') {
      return await checkChatGPTWeb(node, timeout);
    }
    if (mode === 'api_only') {
      return await checkOpenAIAPI(node, timeout);
    }
    // api_then_web（默认）
    const apiOk = await checkOpenAIAPI(node, timeout);
    if (apiOk) return true;
    return await checkChatGPTWeb(node, timeout);
  }

  async function checkOpenAIAPI(node, timeout) {
    try {
      const res = await $.http.get({
        url: apiUrl,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Authorization': 'Bearer sk-INVALID',
        },
        node,
        timeout
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      const body = ((res.body ?? res.rawBody ?? '') + '').trim();

      // 429 多为限流/WAF；默认不放行
      if (status === 429) return allow429 ? looksLikeJson(body) : false;

      // 403 多为风控/封控；默认不放行（除非你显式允许）
      if (status === 403) return allow403 ? looksLikeJson(body) : false;

      // 严格模式：必须 401 + body 像 JSON（OpenAI API 错误一般是 JSON）
      if (strict) {
        if (status !== 401) return false;
        return looksLikeJson(body);
      }

      // 宽松模式：仍主要接受 401（但允许 body 不是 JSON 的极端情况）
      if (status === 401) return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  async function checkChatGPTWeb(node, timeout) {
    try {
      const res = await $.http.get({
        url: webUrl,
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        node,
        timeout
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      if (webOkStatuses.has(status)) return true;

      return false;
    } catch (e) {
      return false;
    }
  }

  function looksLikeJson(str) {
    try { JSON.parse(str); return true; } catch (e) { return false; }
  }

  // --- 工具函数（缓存、指纹、并发执行） ---

  function addPrefix(proxy) {
    if (!proxy.name.includes(prefixStr)) {
      proxy.name = prefixStr + proxy.name;
    }
  }

  function getProxyCacheKey(proxy) {
    const fingerprint = getFingerprint(proxy);
    return `gpt_check_standalone_v4:${fingerprint}`;
  }

  function getBatchKey(proxies) {
    const fps = proxies.map(p => getFingerprint(p)).sort();
    const h = hashStrings(fps);
    return `gpt_check_batch_v2:${h}`;
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

  function getFingerprint(proxy) {
    const entries = Object.entries(proxy)
      .filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(Object.fromEntries(entries));
  }

  function executeAsyncTasks(tasks, { concurrency = 1, deadline } = {}) {
    return new Promise(resolve => {
      let running = 0;
      let index = 0;

      function executeNextTask() {
        if (deadline && Date.now() > deadline) return running === 0 ? resolve() : null;

        while (index < tasks.length && running < concurrency) {
          const currentTask = tasks[index++];
          running++;
          Promise.resolve()
            .then(currentTask)
            .catch(() => { })
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
    (s || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => {
      const n = parseInt(x);
      if (!isNaN(n)) set.add(n);
    });
    if (set.size === 0) {
      set.add(200);
      set.add(302);
    }
    return set;
  }

  function compileDenyRegex(v) {
    if (!v) return null;
    try {
      return new RegExp(v, 'i');
    } catch (e) {
      return null;
    }
  }
}
