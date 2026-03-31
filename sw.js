/**
 * Service Worker：负责静态资源离线缓存与更新。
 *
 * 设计目标：
 * - 首次安装时预缓存核心资源，提升二次打开速度。
 * - 运行时采用“缓存优先 + 后台刷新”策略（stale-while-revalidate）。
 */
let cacheName = "sourceCache";
// resources: 需要缓存的资源相对路径。"" 代表当前入口页面。
let resorces = ["", "script.js", "style.css", "favicon.ico"];
// pathname: SW 作用域根路径，用于拼接成绝对路径匹配。
let pathname = new URL(self.registration.scope).pathname;
resorces = resorces.map((s) => pathname + s);

/**
 * 预缓存流程：打开缓存命名空间并一次性加入核心资源。
 * @returns {Promise<void>}
 */
async function precache() {
  let cache = await caches.open(cacheName);
  return cache.addAll(resorces);
}

// install 阶段：完成预缓存后再结束安装。
self.addEventListener("install", (e) => {
  e.waitUntil(precache());
});

/**
 * 缓存刷新策略：
 * 1) 发起网络请求 refresh。
 * 2) 请求成功时回写缓存。
 * 3) 若非根路径环境，优先返回缓存命中；否则返回网络结果。
 *
 * @param {Request} req 请求对象
 * @returns {Promise<Response>}
 */
async function cacheRefresh(req) {
  let refresh = fetch(req).then(async (rsp) => {
    if (rsp.ok) {
      let cache = await caches.open(cacheName);
      cache.put(req, rsp.clone());
    }
    return rsp;
  });
  return (pathname != "/" ? await caches.match(req) : null) || (await refresh);
}

// fetch 阶段：仅拦截预定义静态资源，避免影响用户图片文件读取逻辑。
self.addEventListener("fetch", (e) => {
  if (resorces.includes(new URL(e.request.url).pathname))
    e.respondWith(cacheRefresh(e.request));
});
