/**
 * Sub-Store 脚本: Claude / Claude Code（Anthropic）可用性检测（可选严格模式 + 多种探测模式）
 *
 * 核心能力：
 * 1) API 优先探测（更贴近 Claude / Claude Code 实际调用链路）：GET https://api.anthropic.com/v1/models
 *    - 使用无效 x-api-key 触发 401 authentication_error（严格模式下必须满足）
 * 2) Web 探测（可选）：GET https://claude.ai
 * 3) 每个节点最多尝试 maxTries 次；失败达到次数后“放弃”（后续不再重测）
 * 4) 同一批节点列表最多执行 maxRuns 轮检测；达到轮次后“锁定仅用缓存”（后续预览/更新不再检测，直接用缓存 ok=true）
 *
 * 参数（建议在 Sub-Store 脚本参数里配置）：
 * - mode: 探测模式（默认 api_then_web）
 *      * api_only      : 只测 API（最严格、最贴近 Claude Code）
 *      * web_only      : 只测 Web（适合只关心网页访问）
 *      * api_then_web  : 先测 API，失败再测 Web（折中）
 * - strict: 是否严格判定（默认 true）
 *      * strict=true  : API 仅接受 401 + 标准 Anthropic 错误 JSON + error.type=authentication_error
 *      * strict=false : API 可接受 401/400/403（需仍符合标准错误 JSON），更“宽松”
 * - allow_429: 是否允许 429 作为“可达”（默认 false；不建议开启）
 * - allow_529: 是否允许 529 作为“可达”（默认 false；不建议开启）
 * - anthropic_version: Anthropic 版本头（默认 2023-06-01）
 * - web_ok_statuses: Web 视为可达的 HTTP 状态码（默认 200,302）
 * - concurrency: 并发数，默认 10
 * - timeout: 单次请求超时(ms)，默认 5000
 * - rename: 'true'|'false'，通过的节点加前缀（默认 false）
 * - prefix: 前缀字符串，默认 '[Claude] '
 * - cache: 'false' 禁用缓存（默认启用）
 * - maxTries/max_tries: 单节点最大尝试次数，默认 2
 * - maxRuns/max_runs: 同批次最大检测轮次，默认 2
 * - force: 'true'|'1' 强制忽略锁定/放弃标记重新检测（需 cache 启用）
 * - deny: 可选，按节点名称正则排除（例如 'HK|香港'）
 *
 * 推荐用法示例：
 * - 最严格（只测 API）：mode=api_only&strict=1
 * - 折中（API 优先、可回退 Web）：mode=api_then_web&strict=1
 * - 只关心网页：mode=web_only
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge } = $.env;

  const concurrency = parseInt($arguments.concurrency || 10);
  const requestTimeout = parseInt($arguments.timeout || 5000);
  const enableRename = ($arguments.rename === 'true');

  const GLOBAL_TIMEOUT = 28000;
  const prefixStr = $arguments.prefix ?? '[Claude] ';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15...ebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const mode = ($arguments.mode || 'api_then_web').toLowerCase(); // api_only | web_only | api_then_web
  const strict = ($arguments.strict === undefined) ? true : ($arguments.strict === 'true' || $arguments.strict === '1');

  const allow429 = ($arguments.allow_429 === 'true' || $arguments.allow_429 === '1') ? true : false;
  const allow529 = ($arguments.allow_529 === 'true' || $arguments.allow_529 === '1') ? true : false;

  const ANTHROPIC_VERSION = $arguments.anthropic_version ?? '2023-06-01';
  const apiUrl = 'https://api.anthropic.com/v1/models';
  const webUrl = 'https://claude.ai';

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
        const isOk = await checkClaude(node, requestTimeout);

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

  async function checkClaude(node, timeout) {
    if (mode === 'web_only') {
      return await checkClaudeWeb(node, timeout);
    }
    if (mode === 'api_only') {
      return await checkAnthropicAPI(node, timeout);
    }
    // api_then_web（默认）
    const apiOk = await checkAnthropicAPI(node, timeout);
    if (apiOk) return true;
    return await checkClaudeWeb(node, timeout);
  }

  async function checkAnthropicAPI(node, timeout) {
    try {
      const res = await $.http.get({
        url: apiUrl,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-invalid',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        node,
        timeout
      });

      const status = parseInt(res.status ?? res.statusCode ?? 0);
      const body = ((res.body ?? res.rawBody ?? '') + '').trim();
      const j = tryParseJson(body);

      // 429/529：通常是限流/过载，不建议当作“可用”
      if (status === 429) return allow429 ? looksLikeAnthropicError(j) : false;
      if (status === 529) return allow529 ? looksLikeAnthropicError(j) : false;

      // 严格模式：必须 401 + 标准错误结构 + authentication_error
      if (strict) {
        if (status !== 401) return false;
        if (!looksLikeAnthropicError(j)) return false;
        const et = (j && j.error && typeof j.error.type === 'string') ? j.error.type : '';
        return et === 'authentication_error';
      }

      // 宽松模式：401/400/403 + 标准错误结构
      if (status === 401 || status === 400 || status === 403) {
        return looksLikeAnthropicError(j);
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  async function checkClaudeWeb(node, timeout) {
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

  function tryParseJson(str) {
    try { return JSON.parse(str); } catch (e) { return null; }
  }

  function looksLikeAnthropicError(j) {
    if (!j || typeof j !== 'object') return false;
    if (j.type !== 'error') return false;
    if (!j.error || typeof j.error !== 'object') return false;
    if (typeof j.error.type !== 'string') return false;
    if (typeof j.error.message !== 'string') return false;
    return true;
  }

  // --- 工具函数（缓存、指纹、并发执行） ---

  function addPrefix(proxy) {
    if (!proxy.name.includes(prefixStr)) {
      proxy.name = prefixStr + proxy.name;
    }
  }

  function getProxyCacheKey(proxy) {
    const fingerprint = getFingerprint(proxy);
    return `claude_check_standalone_v4:${fingerprint}`;
  }

  function getBatchKey(proxies) {
    const fps = proxies.map(p => getFingerprint(p)).sort();
    const h = hashStrings(fps);
    return `claude_check_batch_v2:${h}`;
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
