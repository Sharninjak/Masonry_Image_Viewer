navigator.serviceWorker.register("sw.js");

// #region Helper Classes & Functions
/**
 * 轻量异步队列.
 *
 * 作用:
 * - 在“图片路径生产者(目录遍历)”与“图片路径消费者(loadNext)”之间做缓冲.
 * - 当消费者先于生产者执行时,`shift()` 会返回一个 Promise,等后续 `push()` 时再继续.
 *
 * 设计意义:
 * - 避免一次性加载全部图片造成卡顿.
 * - 支持“边扫描目录边显示图片”的渐进式体验.
 */
class Queue {
  constructor(items = []) {
    // _items: Array<any>,真实存储数据的数组.
    this._items = items;
    // head: number,当前出队指针,避免频繁 shift 导致数组搬移.
    this.head = 0;
    // getters: Array<Function>,保存等待数据的 Promise resolve 回调.
    this.getters = [];
  }
  get items() {
    // 返回当前队列剩余的有效数据.
    return this._items;
  }
  set items(val) {
    // 直接替换底层数据,并重置指针与等待者,适用于批量更新场景.
    this._items = val;
    this.head = 0;
    this.process();
  }
  push(item) {
    // 入队:添加数据后尝试触发等待者.
    this._items.push(item);
    this.process(); 
  }
  shift() {
    // 出队:如果有等待者且队列非空,直接返回数据；否则返回一个 Promise,等待后续 push.
    if (this.head >= this._items.length)
      return new Promise((resolve) => this.getters.push(resolve));
    return this._items[this.head++];
  }
  process() {
    // 处理等待者:当有等待者且队列非空时,依次满足等待者的请求.
    if (this.getters.length > 0 && this.head < this._items.length)
      this.getters.shift()(this._items[this.head++]);
  }
}

/**
 * 从 DataView 中读取 24-bit 无符号整数.
 * @param {DataView} view 二进制视图
 * @param {number} byteOffset 起始字节偏移
 * @param {boolean} littleEndian 是否按小端序读取
 * @returns {number} 0~16777215 的整数
 *
 * 作用:WebP 某些头字段(VP8X/VP8L)使用 3 字节存储尺寸信息,原生 API 没有 getUint24.
 */
function getUint24(view, byteOffset, littleEndian) {
  // 通过连续读取三个字节并按序组合成一个整数,实现 getUint24 功能.
  if (littleEndian) {
    // getUint8: 读取单个字节,返回 0~255 的整数.通过位运算组合成最终结果.
    // 小端序:低字节在前,依次左移8位组合成整数.
    return (
      view.getUint8(byteOffset) |
      (view.getUint8(byteOffset + 1) << 8) |
      (view.getUint8(byteOffset + 2) << 16)
    );
  } else {
    // 大端序:高字节在前,依次左移16位组合成整数.
    return (
      (view.getUint8(byteOffset) << 16) |
      (view.getUint8(byteOffset + 1) << 8) |
      view.getUint8(byteOffset + 2)
    );
  }
}

/**
 * 低成本读取图片宽高.
 * @param {File} file 浏览器 File 对象
 * @returns {Promise<[number, number, HTMLImageElement?]>}
 * - 前两项:宽和高
 * - 第三项(可选):如果走了 Image 解码回退路径,会把已解码的 img 返回,减少重复解码
 *
 * 原理:
 * - 先读文件头(几十字节)可快速得到 PNG/GIF/BMP/WEBP/JPEG 尺寸,性能远高于完整解码.
 * - 如果头信息无法识别,再回退到创建 Image 读取 naturalWidth/Height,保证兼容性.
 * 
 * async: 由于 File.slice 和 Image 解码都是异步操作,函数返回一个 Promise,最终解析为宽高数组和可选的 img 对象.
 */
async function getWH(file) {
  if (file.size < 30) return [0, 0]; // 过小的文件无法包含完整头信息,直接返回 (0, 0).
  let view = new DataView(await file.slice(0, 30).arrayBuffer()); // 读取前30字节头信息,足以覆盖常见格式的尺寸字段.
  let sign = view.getUint32(); // 读取前4字节作为文件签名,用于识别格式.
  if (sign === 0x89504e47) return [view.getUint32(16), view.getUint32(20)]; // PNG:宽高分别位于第16和20字节,均为大端序32位整数.
  else if (sign === 0x47494638)
    // GIF:宽高分别位于第6和8字节,均为小端序16位整数.
    return [view.getUint16(6, true), view.getUint16(8, true)];
  else if (sign >>> 16 === 0x424d)
    // BMP:前两个字节为 'BM' (0x424d),宽高分别位于第18和22字节,均为小端序32位整数.
    return [view.getInt32(18, true), view.getInt32(22, true)];
  else if (sign === 0x52494646) {
    // WEBP:RIFF 格式,前4字节为 'RIFF' (0x52494646),第8字节为 'WEBP' (0x57454250),尺寸信息根据子格式不同而不同.
    let vp8 = view.getUint32(12);
    if (vp8 === 0x56503820)
      // VP8 (有损):宽高分别位于第26和28字节,均为小端序16位整数.
      return [view.getUint16(26, true), view.getUint16(28, true)];
    else if (vp8 === 0x56503858)
      // VP8X (扩展):宽高分别位于第24和27字节,均为小端序24位整数,需要 getUint24 辅助函数.
      return [getUint24(view, 24, true) + 1, getUint24(view, 27, true) + 1];
    else if (vp8 === 0x5650384c) {
      // VP8L (无损):宽高分别位于第21和22字节,宽高信息被压缩在 5 字节中,需要通过位运算解压得到实际尺寸.
      return [
        (view.getUint16(21, true) & 0x3fff) + 1,
        ((getUint24(view, 22, true) >>> 6) & 0x3fff) + 1,
      ];
    }
  } else if (sign >>> 8 === 0xffd8ff) {
    // JPEG:以 0xffd8ff 开头,尺寸信息位于某个 0xffc0 或 0xffc2 标记段中,需要循环读取标记段来寻找.
    view = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    let marker;
    let offset = 2;
    while (offset < view.byteLength) {
      // JPEG 文件由一系列标记段组成,每个段以 0xff 开头,后跟一个字节表示类型.
      // 需要找到类型为 0xc0 (SOF0) 或 0xc2 (SOF2) 的段,它们包含了图像的宽高信息.
      marker = view.getUint16(offset);
      offset += 2;
      if (marker === 0xffc0 || marker === 0xffc2)
        // 找到 SOF0 或 SOF2 段,宽高分别位于段内的第3和第5字节,均为大端序16位整数.
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += view.getUint16(offset);
    }
  }
  // 如果以上格式识别都失败了,说明无法通过头信息获取尺寸,只能回退到 Image 解码路径.
  let img = await new Promise((resolve) => {
    // 创建一个 Image 对象,通过 URL.createObjectURL 将 File 转换为可加载的 URL,触发图片加载.
    let img = new Image();
    let onloaded = () => {
      // 无论加载成功还是失败,都要 revokeObjectURL 释放内存,并解析出宽高返回.
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onload = onloaded;
    img.onerror = onloaded;
    img.src = URL.createObjectURL(file); // 触发图片加载,最终会调用 onloaded 回调,返回 img 对象供调用者使用.
  });
  return [img.naturalWidth, img.naturalHeight, img];
}

/**
 * 节流:在 ms 时间窗内最多执行一次.
 * 这里当前文件未实际使用,保留为通用工具.
 */
function throttle(func, ms = 1000) {
  let timeout;
  let con = this;
  return function () {
    if (timeout) return;
    func.apply(con, arguments);
    timeout = setTimeout(() => (timeout = null), ms);
  };
}

/**
 * 防抖:在连续触发结束后再执行.
 * 这里当前文件未实际使用,保留为通用工具.
 */
function debounce(func, ms = 1000) {
  let timeout;
  let con = this;
  return function () {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(con, arguments), ms);
  };
}

/**
 * 生成数值区间数组 [start, end) ,步长 step.
 * @returns {number[]} 常用于像素数据遍历.
 */
function range(start, end, step = 1) {
  let arr = [];
  for (let i = start; i < end; i += step) arr.push(i);
  return arr;
}

/**
 * 将对象某一路径下的嵌套对象扁平化为值数组.
 * 当前文件未被使用,属于预留工具函数.
 */
function flatObj(obj, path) {
  obj = path.split("/").reduce((obj, name) => obj[name], obj);
  function recurse(obj) {
    for (let key in obj) {
      if (typeof obj[key] === "object") recurse(obj[key]);
      else arr.push(obj[key]);
    }
  }
  let arr = [];
  recurse(obj);
  return arr;
}

// 常量:MB/GB 用于展示文件体积时的人类可读格式.
let MB = 1024 ** 2;
let GB = 1024 ** 3;
/**
 * 把字节数格式化为 B/KB/MB.
 * @param {number} bytes 文件大小(字节)
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  else if (bytes < MB) return `${(bytes / 1024).toFixed(2)} KB`;
  else if (bytes < GB) return `${(bytes / MB).toFixed(2)} MB`;
}

// sleep: Promise 版延时工具(当前文件未使用).
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// log: console.log 简写(当前文件未使用).
let log = console.log;
// getEl/newEl: DOM 获取与创建简写,减少重复代码.
let getEl = (id) => document.getElementById(id);
let newEl = (tag) => document.createElement(tag);
const GALLERY_DB = "masonryViewerDB";
const GALLERY_DB_VERSION = 3;
const GALLERY_STORE = "galleries";
const HANDLES_STORE = "handles"; // FileSystemHandle 单独存储，与元数据隔离
const HISTORY_STORE = "fileLists"; // 保留用于 v1 数据迁移
// #endregion

class MasonryViewer {
  constructor() {
    // docEl: 根文档元素,用于滚动、CSS 变量和视口尺寸读取.
    this.docEl = document.documentElement;
    // ui: 缓存所有常用 DOM 节点,避免多次 query.
    this.ui = this.initUI();
    
    /**
     * 运行时状态集中管理(state tree).
     * 约定:
     * - 布局/加载控制字段放在这里,便于重排与事件处理共享.
     * - 与单个图片绑定的数据,放入 allData 的 value 对象中.
     */
    this.state = {
      zoom: null, // HTMLImageElement|null,当前全屏查看中的图片节点.
      flextype: null, // "colflex"|"rowflex",两种布局模式.
      currdir: null, // HTMLLIElement|null,目录树当前高亮节点.
      pendingJumpDirPath: null, // string|null,点击目录后待命中的目录路径.
      pendingJumpDirIndex: null, // number|null,待命中目录对应的索引标记.
      minCol: null, // number|null,当前布局下最短列的索引,用于瀑布流追加时的列高比较.
      // minR/maxR: number|undefined,宽高比过滤范围.
      minR: undefined,
      maxR: undefined,
      held: false, // 保留字段(当前未使用).
      dircount: 0, // number,扫描到的目录数量.
      loadingAll: 0, //  0|1,是否进入连续加载模式(忽略滚动门槛).
      loading: 0, // number,正在解码中的图片计数,避免并发冲突.
      filting: 0, //保留字段(当前未使用).
      imgcols: [], // HTMLElement[],瀑布流各列容器.
      // marks: HTMLElement[],目录分隔标记节点队列,用于滚动时高亮目录.
      marks: [], // HTMLLIElement|null,当前高亮的目录节点,用于目录高亮切换.
      // allData: Map<string, number | {file, img?, wrap?, thumb?}>
      // key 为路径；目录 value 为索引 number,文件 value 为数据对象.
      allData: new Map(),
      // toLoad: Queue,等待加载的路径队列.
      toLoad: new Queue(),
      // visImgs: Set<number>,当前视口内图片序号,用于缩放导航时判断是否需先滚动.
      visImgs: new Set(),
      // currentGalleryId: string|null,当前已加载图库的 ID.
      currentGalleryId: null,
    };

    // configs: 需要持久化到 CSS 变量与 localStorage 的配置项 id 列表.
    this.configs = [
      "colgap",
      "rowgap",
      "imgradius",
      "imgborder",
      "colcount",
      "minheight",
    ];

    // enums: 集中维护枚举字面量,避免硬编码字符串散落.
    this.enums = {
      colflex: "colflex",
      rowflex: "rowflex",
      default: "default",
      name: "name",
      date: "date",
      size: "size",
      asc: "asc",
      desc: "desc",
    };

    // 会话内 handle 内存缓存：entryId → FileSystemHandle
    // 即使 IDB 序列化失败，同一会话内加载图库也无需重新授权
    this._handleCache = new Map();

    this.initObservers();
    this.initFlex();
    this.initSort();
    this.initFilt();
    this.configs.forEach((id) => this.initConfig(id));
    this.bindEvents();
    this.renderGalleryList();
    
    // 初始化统计面板(总数/已加载/已显示).
    ["totalcount", "loadedcount", "showcount"].forEach(id => {
      this.ui[id].value = 0;
      this.ui[id].innerText = 0;
    });
  }

  initUI() {
    /**
     * 收集并缓存页面中的关键 DOM 节点.
     * 返回值:对象字典,键名与元素 id 一致,供其它方法通过 this.ui.xxx 访问.
     * 作用:
     * - 降低 DOM 查询开销
     * - 统一管理 UI 依赖,避免魔法字符串分散
     */
    return {
      aspectratio: getEl("aspectratio"),
      colcountinput: getEl("colcountinput"),
      cover: getEl("cover"),
      cursorplace: getEl("cursorplace"),
      dirtree: getEl("dirtree"),
      filtborder: getEl("filtborder"),
      filtmono: getEl("filtmono"),
      hint: getEl("hint"),
      hintmain: getEl("hintmain"),
      gallerybtn: getEl("gallerybtn"),
      gallerybar: getEl("gallerybar"),
      gallerycontent: getEl("gallerycontent"),
      historybox: getEl("historybox"),
      imgbox: getEl("imgbox"),
      indicator: getEl("indicator"),
      jumpTo: getEl("jumpTo"),
      loadall: getEl("loadall"),
      loadedcount: getEl("loadedcount"),
      minheightinput: getEl("minheightinput"),
      nextimg: getEl("nextimg"),
      order: getEl("order"),
      pause: getEl("pause"),
      perload: getEl("perload"),
      previmg: getEl("previmg"),
      resort: getEl("resort"),
      revert: getEl("revert"),
      showcount: getEl("showcount"),
      sidebar: getEl("sidebar"),
      sidebtn: getEl("sidebtn"),
      addsource: getEl("addsource"),
      sortby: getEl("sortby"),
      toend: getEl("toend"),
      totalcount: getEl("totalcount"),
      totop: getEl("totop"),
      treebar: getEl("treebar"),
      treebtn: getEl("treebtn"),
    };
  }

  initObservers() {
    /**
     * 图片可见性观察器:
     * - 进入视口:加入 visImgs
     * - 离开视口:移出 visImgs
     * 作用:缩放态切换上一张/下一张时,先判断目标是否可见,必要时自动滚动到位.
     */
    this.imgObs = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) this.state.visImgs.add(e.target.index);
        else this.state.visImgs.delete(e.target.index);
      });
    });

    /**
     * 目录标记观察器:
     * 每当目录分隔 mark 进入视口,就把目录树对应 li 高亮为 active.
     * 这样用户滚动浏览图片时,左侧目录会同步指示当前阅读位置.
     */
    this.dirObs = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) {
          this.state.currdir?.classList.remove("active");
          this.state.currdir?.classList.add("visited");
          this.state.currdir = getEl("li" + e.target.index);
          this.state.currdir.classList.add("active");
        }
      });
    });
  }

  bindEvents() {
    /**
     * 事件绑定总入口.
     * 按职责分为:
     * 1) 文档级输入(拖拽、粘贴、滚动、窗口尺寸变化)
     * 2) 图片查看交互(缩放层鼠标/键盘)
     * 3) 参数面板与目录树控制
     */
    // Document events
    document.ondrop = this.handleDrop.bind(this);
    document.onpaste = this.handlePaste.bind(this);
    document.onscroll = this.loadNext.bind(this);
    document.ondragend = this.copyImg.bind(this);
    document.ondrag = (e) => e.preventDefault();
    document.ondragover = (e) => e.preventDefault();
    document.ondragenter = (e) => e.preventDefault();
    window.onresize = this.loadNext.bind(this);

    // UI events
    this.ui.hintmain.onclick = this.handleHintClick.bind(this);
    this.ui.imgbox.onmouseout = this.addInfo.bind(this);
    this.ui.imgbox.onmouseenter = this.addInfo.bind(this);
    this.ui.imgbox.onclick = this.toggleZoom.bind(this);
    this.ui.cursorplace.onmouseout = this.addInfo.bind(this);
    
    this.ui.cover.onwheel = this.zoomImg.bind(this);
    this.ui.cover.onmousemove = this.moveImg.bind(this);
    this.ui.cover.onmousedown = this.handleCoverMouseDown.bind(this);
    this.ui.cover.oncontextmenu = (e) => e.preventDefault();
    
    this.ui.previmg.onclick = this.naviZoom.bind(this);
    this.ui.nextimg.onclick = this.naviZoom.bind(this);

    document.onkeydown = this.handleKeyDown.bind(this);
    
    this.ui.resort.onclick = () => this.reflow();
    this.ui.pause.onclick = () => (this.state.loadingAll = 0);
    this.ui.totop.onclick = () => this.docEl.scrollTo(0, 0);
    this.ui.toend.onclick = () => this.docEl.scrollTo(0, this.docEl.scrollHeight);
    this.ui.sidebtn.onclick = () => this.ui.sidebar.classList.toggle("show");
    this.ui.addsource.onclick = this.handleAddSourceClick.bind(this);
    this.ui.gallerybtn.onclick = () => this.ui.gallerybar.classList.toggle("show");

    // Close sidebar / gallerybar when clicking outside
    document.addEventListener('click', (e) => {
      if (
        this.ui.sidebar.classList.contains('show') &&
        !this.ui.sidebar.contains(e.target) &&
        !this.ui.sidebtn.contains(e.target)
      ) {
        this.ui.sidebar.classList.remove('show');
      }
      if (
        this.ui.gallerybar.classList.contains('show') &&
        !this.ui.gallerybar.contains(e.target) &&
        !this.ui.gallerybtn.contains(e.target)
      ) {
        this.ui.gallerybar.classList.remove('show');
      }
    });

    this.ui.loadall.onclick = () => {
      this.state.loadingAll = 1;
      this.loadNext();
    };

    this.ui.aspectratio.onkeydown = (e) => {
      if (e.key === "Enter") this.parseRatio();
    };

    this.ui.treebtn.onclick = () => {
      this.ui.treebar.classList.add("show");
      this.state.currdir?.scrollIntoView({ block: "center" });
    };

    this.ui.jumpTo.onkeydown = (e) => {
      if (e.key === "Enter") getEl("img" + parseInt(this.ui.jumpTo.value)).scrollIntoView();
    };

    this.ui.colcountinput.addEventListener("change", () => {
      if (this.state.flextype === this.enums.colflex) this.reflow();
    });

    this.ui.minheightinput.addEventListener("change", () => {
      if (this.state.flextype === this.enums.rowflex)
        requestAnimationFrame(() => {
          this.ui.imgbox.querySelectorAll(".wrap").forEach(this.resize.bind(this));
          this.loadNext();
        });
    });

    this.ui.dirtree.onclick = (e) => {
      let li = e.target;
      if (li.tagName === "LI") {
        // 点击目录后执行“定位跳转”而非“过滤重排”,保持整页可连续滚动浏览.
        this.jumpToDirectory(li);
        this.ui.treebar.classList.remove("show");
      } else {
        this.ui.treebar.classList.remove("show");
      }
    };
  }

  jumpToDirectory(li) {
    /**
     * 跳转到目录首张图片(不会丢失其它目录图片).
     * @param {HTMLLIElement & {path: string, index: number}} li 目录节点
     *
     * 处理策略:
     * 1) 先更新目录高亮状态.
     * 2) 优先在“已渲染图片”中寻找该目录首图并滚动.
     * 3) 若尚未渲染,尝试滚动到目录 mark 分隔符.
     * 4) 若 mark 也没有(说明尚未加载到该目录),记录 pending 目标并开启连续加载,
     *    在后续 loadImg 命中时自动滚动并结束连续加载.
     */
    this.state.currdir?.classList.remove("active");
    this.state.currdir = li;
    this.state.currdir.classList.add("active");
    this.state.currdir.classList.add("visited");

    let prefix = li.path + "/";
    let loadedWrap = [...this.ui.imgbox.querySelectorAll(".wrap")].find((wrap) => {
      let img = wrap.children[0];
      return img?.path?.startsWith(prefix);
    });
    if (loadedWrap) {
      loadedWrap.scrollIntoView({ block: "start" });
      return;
    }

    let mark = getEl("mark" + li.index);
    if (mark) {
      mark.scrollIntoView({ block: "start" });
      return;
    }

    this.state.pendingJumpDirPath = li.path;
    this.state.pendingJumpDirIndex = li.index;
    this.state.loadingAll = 1;
    this.loadNext();
  }

  closeMenusIfOpen() {
    // 如果侧边栏或目录树当前是打开状态,就关闭它们.返回值表示是否执行了关闭操作,供调用者根据需要调整后续行为(如是否触发重排).
    let closed = false;
    if (this.ui.sidebar.classList.contains("show")) {
      this.ui.sidebar.classList.remove("show");
      closed = true;
    }
    if (this.ui.treebar.classList.contains("show")) {
      this.ui.treebar.classList.remove("show");
      closed = true;
    }
    return closed;
  }

  initSort() {
    // 初始化排序控制:从 localStorage 恢复用户设置,并绑定 onchange 事件以更新设置和触发重排.
    ["sortby", "order", "perload"].forEach((id) => {
      let store = localStorage.getItem(id);
      let select = getEl(id);
      if (store) select.value = store;
      else if (id === "sortby") select.value = this.enums.name; // Default to filename sort
      select.onchange = (e) => localStorage.setItem(id, e.target.value);
    });
  }

  initFilt() {
    // 初始化过滤控制:从 localStorage 恢复用户设置,并绑定 onclick 事件以更新设置、切换按钮状态、触发重排.
    ["filtmono", "filtborder", "revert"].forEach((id) => {
      let store = localStorage.getItem(id);
      let button = getEl(id);
      button.active = store === "true";
      if (button.active) button.classList.add("active");
      button.onclick = (e) => {
        let button = e.target;
        button.classList.toggle("active");
        button.active = button.classList.contains("active");
        localStorage.setItem(button.id, button.active);
        if (!this.ui.filtmono.active && !this.ui.filtborder.active && this.ui.revert.active) return;
        this.reflow();
      };
    });
  }

  initFlex() {
    // 初始化布局控制:从 localStorage 恢复用户设置,并绑定 onclick 事件以更新设置、切换按钮状态、触发重排.
    let store = localStorage.getItem("flextype");
    this.state.flextype = store !== null ? store : this.enums.colflex;
    getEl(this.state.flextype).classList.add("active");
    this.ui.imgbox.className = this.state.flextype;
    ["colflex", "rowflex"].forEach((id, i, arr) => {
      let el = getEl(id);
      el.onclick = (e) => {
        let button = e.target;
        if (this.state.flextype === button.id) return;
        this.state.flextype = button.id;
        localStorage.setItem("flextype", this.state.flextype);
        this.ui.imgbox.className = this.state.flextype;
        arr.forEach((el) => getEl(el).classList.remove("active"));
        button.classList.add("active");
        this.reflow();
      };
    });
  }

  initConfig(id) {
    // 初始化配置项:从 localStorage 恢复用户设置,并绑定 oninput 和 onchange 事件以实时更新 CSS 变量、保存设置、触发重排.
    let input = getEl(id + "input");
    input.oninput = (e) => (getEl(id).innerText = e.target.value);
    input.onchange = (e) => {
      let val = e.target.value;
      this.configs[id] = val;
      this.docEl.style.setProperty("--" + id, val + "px");
      localStorage.setItem(id, val);
    };
    let store = localStorage.getItem(id);
    if (store) input.value = store;
    input.onchange({ target: input });
    input.oninput({ target: input });
  }

  async handleDrop(e) {
    // 只处理文件拖放,其他类型(如文本)直接忽略.
    if (e.dataTransfer.types[0] !== "Files") return;
    e.preventDefault();
    let handles = await Promise.all(
      [...e.dataTransfer.items].map((item) => item.getAsFileSystemHandle())
    );
    handles = handles.filter(Boolean);
    await this.importFromHandles(handles);
  }

  async handlePaste(e) {
    // 只处理文件粘贴,其他类型(如文本)直接忽略.
    if (e.clipboardData.types[0] !== "Files") return;
    let handles = await Promise.all(
      [...e.clipboardData.items].map((item) => item.getAsFileSystemHandle())
    );
    handles = handles.filter(Boolean);
    await this.importFromHandles(handles);
  }

  async handleHintClick() {
    // 点击提示框时,尝试打开目录选择器导入图片,提供一个额外的入口以提升用户体验.
    try {
      let handle = await showDirectoryPicker({
        mode: "readwrite",
        startIn: "pictures",
      });
      await this.importFromHandles([handle]);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Error selecting directory:', err);
        alert('无法访问目录,请重试');
      }
    }
  }

  async handleAddSourceClick() {
    const pickFolder = confirm("确定:添加文件夹\n取消:添加图片文件");
    try {
      if (pickFolder) {
        const dirHandle = await showDirectoryPicker({
          mode: "readwrite",
          startIn: "pictures",
        });
        await this.importFromHandles([dirHandle]);
        return;
      }
      const fileHandles = await showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: "Images",
            accept: {
              "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"],
            },
          },
        ],
        excludeAcceptAllOption: false,
      });
      await this.importFromHandles(fileHandles);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Error selecting source:", err);
        alert("添加失败，请重试");
      }
    }
  }

  async importFromHandles(handles, { saveToGallery = true } = {}) {
    if (!handles?.length) return;
    this.initLoad();
    await this.handle(handles);
    if (this.ui.sortby.value !== this.enums.default || this.ui.order.value !== this.enums.asc) {
      this.reflow();
    }
    if (saveToGallery) {
      const isNewGallery = await this.addToCurrentGallery(handles);
      await this.renderGalleryList();
      // 新图库创建后自动打开管理面板，告知用户已保存
      if (isNewGallery) {
        this.ui.gallerybar.classList.add("show");
      }
    } else {
      await this.renderGalleryList();
    }
  }

  // --- 图库系统 (IndexedDB v3) ---
  // 架构：图库元数据（纯 JSON）存 galleries store，FileSystemHandle 单独存 handles store。
  // 两者通过 entryId 关联。元数据保存永远可靠；handle 存储用 try-catch 保护，
  // 失败时图库元数据仍安全保存，加载时退回"重新选择"流程。

  async getGalleryDb() {
    if (this.galleryDb) return this.galleryDb;
    this.galleryDb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(GALLERY_DB, GALLERY_DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        // 创建图库元数据 store
        if (!db.objectStoreNames.contains(GALLERY_STORE)) {
          db.createObjectStore(GALLERY_STORE, { keyPath: "id" });
        }
        // 创建 handle 独立 store（keyPath 为 entryId）
        if (!db.objectStoreNames.contains(HANDLES_STORE)) {
          db.createObjectStore(HANDLES_STORE, { keyPath: "entryId" });
        }
        // 迁移 v1 历史记录（仅迁移元数据；不调用 deleteObjectStore，避免 InvalidStateError）
        if (event.oldVersion < 2 && db.objectStoreNames.contains(HISTORY_STORE)) {
          const tx = event.target.transaction;
          const oldStore = tx.objectStore(HISTORY_STORE);
          const newStore = tx.objectStore(GALLERY_STORE);
          oldStore.getAll().onsuccess = (e) => {
            const now = Date.now();
            for (const record of e.target.result) {
              newStore.put({
                id: record.id,
                createdAt: record.createdAt,
                updatedAt: record.createdAt || now,
                name: record.name,
                description: "",
                // 仅保留元数据，不含 handle（handle 需用户重新授权后才可获得）
                entries: (record.entries || []).map((entry) => ({
                  id: `e${now}-${Math.random().toString(36).slice(2, 8)}`,
                  kind: entry.kind,
                  name: entry.handle?.name || (entry.path || "").replace(/^\//, "") || "未知",
                })),
              });
            }
            // 注意：不在此处调用 db.deleteObjectStore(HISTORY_STORE)
            // 原因：该回调在 onupgradeneeded 返回后执行，此时调用会抛出 InvalidStateError
            // 旧 store 作为无害的孤立数据留在 DB 中，不影响功能
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.galleryDb;
  }

  async listGalleries() {
    const db = await this.getGalleryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, "readonly");
      const store = tx.objectStore(GALLERY_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = (req.result || []).sort(
          (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        );
        resolve(records);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getGalleryById(id) {
    const db = await this.getGalleryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, "readonly");
      const store = tx.objectStore(GALLERY_STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async putGallery(gallery) {
    // gallery 对象中不含 FileSystemHandle，序列化始终安全
    const db = await this.getGalleryDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, "readwrite");
      const store = tx.objectStore(GALLERY_STORE);
      const req = store.put(gallery);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deleteGallery(galleryId) {
    const db = await this.getGalleryDb();
    const gallery = await this.getGalleryById(galleryId);
    if (gallery?.entries?.length) {
      const entryIds = gallery.entries.map((e) => e.id);
      await this._deleteHandles(entryIds);
      for (const id of entryIds) this._handleCache.delete(id);
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GALLERY_STORE, "readwrite");
      const store = tx.objectStore(GALLERY_STORE);
      const req = store.delete(galleryId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 将 handle 保存到独立 store，失败时静默忽略（元数据已安全存储）
  async _tryPutHandle(entryId, handle) {
    try {
      const db = await this.getGalleryDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLES_STORE, "readwrite");
        const store = tx.objectStore(HANDLES_STORE);
        const req = store.put({ entryId, handle });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // DataCloneError 等序列化失败：handle 丢失，加载时会提示重新选择，图库元数据不受影响
    }
  }

  async _getHandle(entryId) {
    try {
      const db = await this.getGalleryDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDLES_STORE, "readonly");
        const store = tx.objectStore(HANDLES_STORE);
        const req = store.get(entryId);
        req.onsuccess = () => resolve(req.result?.handle || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async _deleteHandles(entryIds) {
    if (!entryIds.length) return;
    try {
      const db = await this.getGalleryDb();
      await new Promise((resolve) => {
        const tx = db.transaction(HANDLES_STORE, "readwrite");
        const store = tx.objectStore(HANDLES_STORE);
        let done = 0;
        const onDone = () => { if (++done === entryIds.length) resolve(); };
        for (const id of entryIds) {
          const req = store.delete(id);
          req.onsuccess = onDone;
          req.onerror = onDone;
        }
      });
    } catch { /* ignore */ }
  }

  buildGalleryEntries(handles) {
    // 注意：entry 中不含 handle，handle 通过 _tryPutHandle 单独存储
    const now = Date.now();
    return handles.map((handle) => ({
      id: `e${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: handle.kind,
      name: handle.name,
    }));
  }

  async addToCurrentGallery(newHandles) {
    const entries = this.buildGalleryEntries(newHandles);
    if (!entries.length) return false;
    const now = Date.now();

    // 写入会话内存缓存（即使 IDB 序列化失败，同会话内仍可加载）
    entries.forEach((entry, i) => this._handleCache.set(entry.id, newHandles[i]));

    if (this.state.currentGalleryId) {
      const gallery = await this.getGalleryById(this.state.currentGalleryId);
      if (gallery) {
        await this.putGallery({
          ...gallery,
          updatedAt: now,
          entries: [...gallery.entries, ...entries],
        });
        for (let i = 0; i < entries.length; i++) {
          await this._tryPutHandle(entries[i].id, newHandles[i]);
        }
        return false; // 追加到已有图库，非新建
      }
    }

    // 无当前图库时自动创建
    const name =
      entries.length <= 2
        ? entries.map((e) => e.name).join(" + ")
        : `${entries[0].name} 等 ${entries.length} 项`;
    const newGallery = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      name,
      description: "",
      entries,
    };
    await this.putGallery(newGallery);
    for (let i = 0; i < entries.length; i++) {
      await this._tryPutHandle(entries[i].id, newHandles[i]);
    }
    this.state.currentGalleryId = newGallery.id;
    return true; // 新图库已创建
  }

  async ensureHandleReadable(handle) {
    if (!handle?.queryPermission) return true;
    let permission = await handle.queryPermission({ mode: "read" });
    if (permission === "granted") return true;
    permission = await handle.requestPermission({ mode: "read" });
    return permission === "granted";
  }

  async editGalleryMetadata(galleryId, { name, description } = {}) {
    const gallery = await this.getGalleryById(galleryId);
    if (!gallery) return;
    await this.putGallery({
      ...gallery,
      updatedAt: Date.now(),
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
    });
  }

  async removeFromGallery(galleryId, entryId) {
    const gallery = await this.getGalleryById(galleryId);
    if (!gallery) return;
    await this._deleteHandles([entryId]);
    this._handleCache.delete(entryId);
    await this.putGallery({
      ...gallery,
      updatedAt: Date.now(),
      entries: gallery.entries.filter((e) => e.id !== entryId),
    });
  }

  async saveAsNewGallery() {
    const currentName = this.state.currentGalleryId
      ? (await this.getGalleryById(this.state.currentGalleryId))?.name
      : null;
    const name = prompt("图库名称：", currentName ? `${currentName} 副本` : "新图库");
    if (!name?.trim()) return;
    const description = prompt("描述（可选）：", "") || "";
    let entries = [];
    if (this.state.currentGalleryId) {
      const current = await this.getGalleryById(this.state.currentGalleryId);
      if (current?.entries) {
        const now = Date.now();
        entries = current.entries.map((e) => {
          const newId = `e${now}-${Math.random().toString(36).slice(2, 8)}`;
          // 同步内存缓存中的 handle 到新 entryId
          const cachedHandle = this._handleCache.get(e.id);
          if (cachedHandle) this._handleCache.set(newId, cachedHandle);
          return { id: newId, kind: e.kind, name: e.name };
        });
        // 异步复制 IDB 中的 handle
        for (let i = 0; i < current.entries.length; i++) {
          const handle = await this._getHandle(current.entries[i].id);
          if (handle) await this._tryPutHandle(entries[i].id, handle);
        }
      }
    }
    const now = Date.now();
    const newGallery = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      name: name.trim(),
      description: description.trim(),
      entries,
    };
    await this.putGallery(newGallery);
    this.state.currentGalleryId = newGallery.id;
    await this.renderGalleryList();
  }

  async loadGallery(galleryId) {
    try {
      const gallery = await this.getGalleryById(galleryId);
      if (!gallery?.entries?.length) return;

      const handles = [];
      const needReselect = []; // 需要用户重新选择的条目

      for (const entry of gallery.entries) {
        // 优先检查会话内存缓存（同一会话内始终有效）
        let handle = this._handleCache.get(entry.id);
        if (!handle) {
          // 再从 IDB 读取（跨会话持久化）
          handle = await this._getHandle(entry.id);
        }
        if (handle) {
          const ok = await this.ensureHandleReadable(handle);
          if (ok) {
            handles.push(handle);
            this._handleCache.set(entry.id, handle);
            continue;
          }
        }
        needReselect.push(entry);
      }

      // 对无法获取 handle 的条目，提示用户重新选择
      for (const entry of needReselect) {
        const msg = `图库中 "${entry.name}" 的访问已失效，请重新选择该${entry.kind === "directory" ? "文件夹" : "文件"}`;
        if (!confirm(msg)) continue;
        try {
          let newHandle;
          if (entry.kind === "directory") {
            newHandle = await showDirectoryPicker({ mode: "readwrite", startIn: "pictures" });
          } else {
            [newHandle] = await showOpenFilePicker({
              multiple: false,
              types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"] } }],
            });
          }
          if (newHandle) {
            handles.push(newHandle);
            this._handleCache.set(entry.id, newHandle);
            await this._tryPutHandle(entry.id, newHandle);
          }
        } catch (err) {
          if (err.name !== "AbortError") console.error("Re-select failed:", err);
        }
      }

      if (!handles.length) {
        alert("没有可访问的文件来源，已取消加载。");
        return;
      }

      await this.importFromHandles(handles, { saveToGallery: false });
      this.state.currentGalleryId = galleryId;
      await this.putGallery({ ...gallery, updatedAt: Date.now() });
      await this.renderGalleryList();
    } catch (err) {
      console.error("Load gallery failed:", err);
      alert("打开图库失败，请重试");
    }
  }

  async renderGalleryList() {
    let galleries = [];
    try {
      galleries = await this.listGalleries();
    } catch (err) {
      console.error("Load galleries failed:", err);
      return;
    }

    // 构建图库管理面板中的图库条目
    const buildGalleryItem = (gallery) => {
      const isCurrent = gallery.id === this.state.currentGalleryId;
      const item = newEl("div");
      item.className = "gallery-item" + (isCurrent ? " current" : "");

      const header = newEl("div");
      header.className = "gallery-header";

      const nameEl = newEl("div");
      nameEl.className = "gallery-name";
      nameEl.innerText = gallery.name + (isCurrent ? "  (当前)" : "");

      const actions = newEl("div");
      actions.className = "gallery-actions";

      const loadBtn = newEl("button");
      loadBtn.innerText = "加载";
      loadBtn.onclick = async (e) => {
        e.stopPropagation();
        this.ui.gallerybar.classList.remove("show");
        await this.loadGallery(gallery.id);
      };

      const renameBtn = newEl("button");
      renameBtn.innerText = "重命名";
      renameBtn.onclick = async (e) => {
        e.stopPropagation();
        const newName = prompt("新名称：", gallery.name);
        if (!newName?.trim()) return;
        await this.editGalleryMetadata(gallery.id, { name: newName.trim() });
        await this.renderGalleryList();
      };

      const delBtn = newEl("button");
      delBtn.innerText = "删除";
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除图库"${gallery.name}"?`)) return;
        if (this.state.currentGalleryId === gallery.id) this.state.currentGalleryId = null;
        await this.deleteGallery(gallery.id);
        await this.renderGalleryList();
      };

      actions.append(loadBtn, renameBtn, delBtn);
      header.append(nameEl, actions);

      const meta = newEl("div");
      meta.className = "gallery-meta";

      if (gallery.description) {
        const descEl = newEl("div");
        descEl.innerText = gallery.description;
        meta.appendChild(descEl);
      }

      const dateStr = new Date(gallery.updatedAt || gallery.createdAt).toLocaleString();
      const infoEl = newEl("div");
      infoEl.className = "gallery-info-line";
      infoEl.innerText = `${gallery.entries.length} 个来源  ${dateStr}`;
      meta.appendChild(infoEl);

      const manageBtns = newEl("div");
      manageBtns.className = "gallery-manage-btns";

      const editDescBtn = newEl("button");
      editDescBtn.innerText = "编辑描述";
      editDescBtn.onclick = async (e) => {
        e.stopPropagation();
        const newDesc = prompt("描述：", gallery.description || "");
        if (newDesc === null) return;
        await this.editGalleryMetadata(gallery.id, { description: newDesc.trim() });
        await this.renderGalleryList();
      };

      const toggleEntriesBtn = newEl("button");
      toggleEntriesBtn.innerText = "管理来源";

      const entriesList = newEl("div");
      entriesList.className = "gallery-entries";
      entriesList.hidden = true;

      for (const entry of gallery.entries) {
        const entryEl = newEl("div");
        entryEl.className = "gallery-entry";
        const kindLabel = entry.kind === "directory" ? "[目录]" : "[文件]";
        const entryNameEl = newEl("span");
        entryNameEl.innerText = `${kindLabel} ${entry.name}`;
        const removeBtn = newEl("button");
        removeBtn.innerText = "移除";
        removeBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`从图库中移除 "${entry.name}"?`)) return;
          await this.removeFromGallery(gallery.id, entry.id);
          await this.renderGalleryList();
        };
        entryEl.append(entryNameEl, removeBtn);
        entriesList.appendChild(entryEl);
      }

      toggleEntriesBtn.onclick = (e) => {
        e.stopPropagation();
        entriesList.hidden = !entriesList.hidden;
        toggleEntriesBtn.innerText = entriesList.hidden ? "管理来源" : "收起";
      };

      manageBtns.append(editDescBtn, toggleEntriesBtn);
      item.append(header, meta, manageBtns, entriesList);
      return item;
    };

    // 渲染到欢迎页的 historybox
    if (this.ui.historybox && this.ui.hint?.isConnected) {
      this.ui.historybox.replaceChildren();
      const title = newEl("div");
      title.className = "history-title";
      title.innerText = "图库";
      this.ui.historybox.appendChild(title);
      if (!galleries.length) {
        const empty = newEl("div");
        empty.className = "history-meta";
        empty.innerText = "暂无图库，拖入图片文件夹以创建";
        this.ui.historybox.appendChild(empty);
      } else {
        for (const gallery of galleries) {
          const item = newEl("button");
          item.className = "history-item";
          const time = new Date(gallery.updatedAt || gallery.createdAt).toLocaleString();
          const entryNames = gallery.entries.map((e) => e.name).join("  ");
          item.innerText = `${gallery.name}\n${entryNames}\n${time}`;
          item.onclick = async (e) => {
            e.stopPropagation();
            await this.loadGallery(gallery.id);
          };
          this.ui.historybox.appendChild(item);
        }
      }
    }

    // 渲染到图库管理面板
    if (!this.ui.gallerycontent) return;
    this.ui.gallerycontent.replaceChildren();

    const panelHeader = newEl("div");
    panelHeader.className = "gallery-panel-header";
    const panelTitle = newEl("span");
    panelTitle.innerText = "图库管理";
    panelHeader.appendChild(panelTitle);

    if (this.state.currentGalleryId) {
      const saveNewBtn = newEl("button");
      saveNewBtn.className = "gallery-save-new-btn";
      saveNewBtn.innerText = "另存为新图库";
      saveNewBtn.onclick = () => this.saveAsNewGallery();
      panelHeader.appendChild(saveNewBtn);
    }

    this.ui.gallerycontent.appendChild(panelHeader);

    if (!galleries.length) {
      const empty = newEl("div");
      empty.className = "gallery-empty";
      empty.innerText = "暂无图库";
      this.ui.gallerycontent.appendChild(empty);
    } else {
      for (const gallery of galleries) {
        this.ui.gallerycontent.appendChild(buildGalleryItem(gallery));
      }
    }
  }

  initLoad() {
    if (this.ui.loadedcount.value > 0) return;
    if (this.ui.sortby.value === this.enums.default && this.ui.order.value === this.enums.asc) this.reflow();
    this.docEl.style.setProperty("--opacity", "0");
    this.ui.hint.remove();
  }

  async handle(items, dir = "", folderUl = this.ui.dirtree.children[0]) {
    for await (let item of items) {
      let name = item.name;
      let path = dir + "/" + name;
      if (this.state.allData.has(path)) continue;
      
      let index = this.state.allData.size;

      if (item.kind === "directory") {
        this.state.dircount++;
        let val = this.ui.totalcount.value;
        let li = newEl("li");
        li.innerText = name;
        li.id = "li" + index;
        li.index = index;
        li.path = path;
        folderUl.appendChild(li);
        let ul = newEl("ul");
        folderUl.appendChild(ul);
        this.state.toLoad.push(path);
        this.state.allData.set(path, index);
        await this.handle(item.values(), path, ul);
        if (val === this.ui.totalcount.value) {
          li.style.display = "none";
          ul.style.display = "none";
        }
      }
      if (item.kind === "file") {
        let file = await item.getFile();
        if (!file.type.match(/image.*/)) continue;
        this.ui.totalcount.value++;
        file.dir = dir;
        file.path = path;
        file.index = index;
        this.state.allData.set(path, { file });
        this.state.toLoad.push(path);
        this.ui.totalcount.innerText = this.ui.totalcount.value;
      }
    }
  }

  reflow() {
    if (!this.ui.filtmono.active && !this.ui.filtborder.active && this.ui.revert.active) return;
    this.ui.imgbox.querySelectorAll(".mark").forEach((el) => {
      el.remove();
    });
    this.state.minCol = this.ui.imgbox;
    this.state.marks = [];
    this.state.visImgs.clear();
    this.state.imgcols = [];
    if (this.state.flextype === this.enums.colflex) {
      for (let _ of Array(parseInt(this.ui.colcountinput.value))) {
        let imgcol = newEl("div");
        imgcol.className = "imgcol";
        this.state.imgcols.push(imgcol);
        imgcol.onmouseout = this.addInfo.bind(this);
      }
    }
    this.ui.imgbox.replaceChildren(...this.state.imgcols);
    this.state.loading = 0;
    if (this.ui.showcount.value > 0) {
      this.state.toLoad.getters.forEach((rsv) => rsv());
      this.state.toLoad.items = [...this.state.allData.keys()];
      this.ui.showcount.value = 0;
    }
    let items = [...this.state.allData.keys()];
    let key = this.ui.sortby.value;
    if (key !== this.enums.default)
      items = items
        .filter((p) => typeof this.state.allData.get(p) === "object")
        .sort((a, b) => {
            let fileA = this.state.allData.get(a).file;
            let fileB = this.state.allData.get(b).file;
            if (key === 'name') {
              return fileA.name.localeCompare(fileB.name, undefined, {numeric: true, sensitivity: 'base'});
            }
            return fileA[key] - fileB[key];
        });
    if (this.ui.order.value === this.enums.desc) items.reverse();
    this.state.toLoad.items = items;
    this.loadNext();
  }

  async loadNext() {
    if (
      this.state.loading > 0 ||
      (!this.state.loadingAll &&
        this.docEl.scrollTop + this.docEl.clientHeight <
          this.state.minCol.scrollHeight - this.docEl.clientHeight)
    )
      return;
    for (let _ of Array(parseInt(this.ui.perload.value))) {
      let path = await this.state.toLoad.shift();
      if (!path) return;
      let data = this.state.allData.get(path);
      if (typeof data === "number") {
        let mark = newEl("div");
        mark.className = "mark";
        mark.id = "mark" + data;
        mark.index = data;
        this.dirObs.observe(mark);
        this.state.marks.push(mark);
        continue;
      }
      let file = data.file;
      let w, h, img;
      if (this.state.maxR) {
        if (file.width) [w, h] = [file.width, file.height];
        else {
          [w, h, img] = await getWH(file);
          [file.width, file.height] = [w, h];
          if (img) data.img = img;
        }
        if (h * this.state.minR > w + 2 || h * this.state.maxR < w - 2) continue;
      }
      let wrap = data.wrap;
      if (wrap) {
        this.loadImg(wrap);
        continue;
      }
      let onloaded = () => {
        URL.revokeObjectURL(img.src);
        this.ui.loadedcount.innerText = this.ui.loadedcount.value++ + 1;
        let wrap = newEl("div");
        wrap.className = "wrap";
        wrap.appendChild(img);
        data.wrap = wrap;
        this.loadImg(wrap);
        this.state.loading--;
        this.loadNext();
      };
      if (data.img) {
        img = data.img;
        onloaded();
      } else {
        img = new Image();
        data.img = img;
        this.state.loading++;
        img.onload = onloaded;
        img.onerror = onloaded;
        img.src = URL.createObjectURL(file);
      }
      img.index = file.index;
      img.alt = file.name;
      img.path = file.path;
    }
    setTimeout(this.loadNext.bind(this), 0);
  }

  addInfo(e) {
    // 鼠标进入图片或缩放层时,在图片容器内动态生成一个信息栏显示文件大小、分辨率、修改日期等元信息;鼠标离开时移除信息栏.
    // 通过检查事件目标和相关目标的标签名与状态,确保只对图片元素触发该行为,避免干扰其它交互.
    let img = e.relatedTarget;
    if (img?.tagName !== "IMG") return;
    let wrap = img.parentElement;
    if (wrap.hasInfo) return;
    let file = this.state.allData.get(img.path).file;
    let imgInfo = [
      formatSize(file.size),
      `${img.naturalWidth}x${img.naturalHeight}`,
      file.lastModifiedDate.toLocaleString().replaceAll("/", "-"),
      file.name,
      file.dir,
    ];
    imgInfo = imgInfo.flatMap((t) => {
      let span = newEl("span");
      span.innerText = t;
      let br = newEl("br");
      return [span, br];
    });
    let infoBar = newEl("div");
    infoBar.classList.add("info");
    infoBar.replaceChildren(...imgInfo);
    wrap.appendChild(infoBar);
    wrap.hasInfo = 1;
  }

  loadImg(wrap) {
    let img = wrap.children[0];
    if (
      ((this.ui.filtmono.active && this.isMono(img)) ||
        (this.ui.filtborder.active && this.isMonoBorder(img))) ^ this.ui.revert.active
    )
      return;
    this.imgObs.observe(wrap);
    wrap.removeAttribute("style");
    this.ui.showcount.innerText = this.ui.showcount.value++ + 1;
    wrap.id = "img" + this.ui.showcount.value;
    wrap.index = this.ui.showcount.value;
    if (img.index > this.state.marks[0]?.index) wrap.appendChild(this.state.marks.shift());
    if (this.state.flextype === this.enums.colflex) {
      this.state.minCol = this.state.imgcols.reduce((prev, curr) =>
        prev.offsetHeight <= curr.offsetHeight ? prev : curr
      );
      this.state.minCol.appendChild(wrap);
    } else {
      this.resize(wrap);
      this.ui.imgbox.appendChild(wrap);
    }
    if (this.state.pendingJumpDirPath) {
      let prefix = this.state.pendingJumpDirPath + "/";
      if (img.path?.startsWith(prefix)) {
        wrap.scrollIntoView({ block: "start" });
        this.state.pendingJumpDirPath = null;
        this.state.pendingJumpDirIndex = null;
        this.state.loadingAll = 0;
      }
    }
  }

  resize(wrap) {
    let img = wrap.children[0],
      ratio = img.naturalWidth / img.naturalHeight;
    wrap.style.flexBasis = ratio * this.ui.minheightinput.value + "px";
    wrap.style.flexGrow = ratio;
  }

  isMonoBorder(img) {
    if (img.isMonoBorder !== undefined) return img.isMonoBorder;
    let { ctx, width, height } = this.getThumb(img);
    let d = (x, y, w, h) => ctx.getImageData(x, y, w, h).data;
    let wasd = [
      ...d(0, 0, 1, height),
      ...d(0, 0, width, 1),
      ...d(width - 1, 0, 1, height),
      ...d(0, height - 1, width, 1),
    ];
    let bns = [];
    for (let i of range(0, wasd.length, 4))
      bns.push(Math.round((wasd[i] + wasd[i + 1] + wasd[i + 2]) / 3 / 4));
    let counts = bns.reduce(
      (acc, curr) => acc.set(curr, (acc.get(curr) || 0) + 1),
      new Map()
    );
    if (Math.max(...counts.values()) > 0.0625 * wasd.length) {
      img.isMonoBorder = true;
      return true;
    }
    img.isMonoBorder = false;
    return false;
  }

  isMono(img) {
    // 通过采样缩略图的 RGBA 数据,统计四个区域的平均亮度,如果存在明显差异则判定为非单色图片.
    if (img.isMono !== undefined) return img.isMono;
    let { ctx, width, height } = this.getThumb(img);
    let pixels = width * height,
      data = ctx.getImageData(0, 0, width, height).data;
    for (let area of range(0, 4)) {
      let r = 0,
        g = 0,
        b = 0;
      for (let i of range(area * pixels, (area + 1) * pixels, 4)) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      if (Math.max(r, g, b) - Math.min(r, g, b) > pixels) {
        img.isMono = false;
        return false;
      }
    }
    img.isMono = true;
    return true;
  }

  getThumb(img, l = 100) {
    let data = this.state.allData.get(img.path);
    if (l === 100) {
      let thumb = data.thumb;
      if (thumb) return thumb;
    }
    let canvas = newEl("canvas"),
      ctx = canvas.getContext("2d", { willReadFrequently: true }),
      wh = [img.naturalWidth, img.naturalHeight],
      m = Math.max(...wh),
      r = l / m;
    wh = wh.map((n) => Math.round(n * r));
    [canvas.width, canvas.height] = wh;
    ctx.drawImage(img, 0, 0, ...wh);
    let thumb = { canvas, ctx, width: wh[0], height: wh[1] };
    if (l === 100) data.thumb = thumb;
    return thumb;
  }

  toggleZoom(e) {
    // 点击图片或其 info 栏进入缩放状态,生成替身占位并将原图提升到 cover 层进行缩放展示.
    let oriimg = e.target;
    if (oriimg.className === "info") {
      if (!getSelection().isCollapsed) return;
      oriimg = oriimg.parentElement.children[0];
    } else if (oriimg.tagName !== "IMG") return;
    if (this.closeMenusIfOpen()) return;
    let rep = new Image();
    rep.id = "rep";
    rep.width = oriimg.naturalWidth;
    rep.height = oriimg.naturalHeight;
    oriimg.replaceWith(rep);
    this.state.zoom = oriimg;
    this.state.zoom.className = "zoom";
    this.state.zoom.style.top = (this.docEl.clientHeight - this.state.zoom.height) / 2 + "px";
    this.state.zoom.style.left = (this.docEl.clientWidth - this.state.zoom.width) / 2 + "px";
    this.state.zoom.scale =
      Math.min(
        this.docEl.clientHeight / this.state.zoom.height,
        this.docEl.clientWidth / this.state.zoom.width,
        1
      ).toFixed(2) - 0.01;
    this.state.zoom.style.scale = this.state.zoom.scale;
    this.state.zoom.minscale = this.state.zoom.scale;
    this.state.zoom.style.transform = `translateZ(0)`;
    this.ui.cover.appendChild(this.state.zoom);
    this.ui.cover.classList.add("show");
    this.ui.cover.focus();
  }

  zoomImg(e) {
    // 根据滚轮滚动方向调整缩放比例,并调用 moveImg 保持缩放中心不变.
    e.preventDefault();
    if (
      (e.deltaY < 0 && this.state.zoom.scale > 4) ||
      (e.deltaY > 0 && this.state.zoom.scale < this.state.zoom.minscale)
    )
      return;
    this.state.zoom.scale *= e.deltaY < 0 ? 1.25 : 0.8;
    this.moveImg(e);
  }

  moveImg(e) {
    // 根据鼠标位置和当前缩放比例计算图片的平移,保持鼠标指针相对于图片的位置不变.
    let t,
      l,
      ih = this.state.zoom.clientHeight * this.state.zoom.scale,
      iw = this.state.zoom.clientWidth * this.state.zoom.scale,
      dh = this.docEl.clientHeight,
      dw = this.docEl.clientWidth;
    if (ih > dh) {
      t = -(ih - dh + 0.2 * dh) * (e.clientY / dh - 0.5);
    } else t = 0;
    if (iw > dw) {
      l = -(iw - dw + 0.2 * dw) * (e.clientX / dw - 0.5);
    } else l = 0;
    this.state.zoom.style.scale = this.state.zoom.scale;
    this.state.zoom.style.translate = `${l}px ${t}px 0px`;
  }

  hideCover() {
    // 退出缩放状态,恢复图片原位并清理缩放相关状态.
    if (!this.state.zoom) return;
    this.state.zoom.removeAttribute("style");
    this.state.zoom.removeAttribute("class");
    getEl("rep").replaceWith(this.state.zoom);
    this.state.zoom = null;
    this.ui.cover.classList.remove("show");
  }

  handleCoverMouseDown(e) {
    // 左键/右键切换上一张/下一张,中键或 Esc 键退出缩放.
    if (!this.state.zoom) return; // 安全检查: 确保当前处于缩放状态
    if (e.target === this.ui.previmg || e.target === this.ui.nextimg) return; // 避免重复触发导航事件
    if (e.button === 0) { // 左键
      this.naviZoom({ target: this.ui.previmg, stopPropagation() {} });
      // stopPropagation 避免触发 cover 的 onclick 导致的 toggleZoom
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      this.naviZoom({ target: this.ui.nextimg, stopPropagation() {} });
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.hideCover();
    }
  }

  handleKeyDown(e) {
    if (!this.state.zoom) return;
    if (
      e.key === "Escape" ||
      e.key === "s"
    ) {
      this.hideCover();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "d") {
      this.naviZoom({ target: this.ui.nextimg, key: e.key, stopPropagation() {} });
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "a") {
      this.naviZoom({ target: this.ui.previmg, key: e.key, stopPropagation() {} });
    }
  }

  copyImg(e) {
    let img = e.target;
    if (img.tagName !== "IMG") return;
    let { canvas } = this.getThumb(img, 1920);
    canvas.toBlob((blob) =>
      navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    );
    e.preventDefault();
  }

  naviZoom(e) {
    e.stopPropagation();
    let index = getEl("rep").parentElement.index;
    index +=
      e.target === this.ui.nextimg || e.key === "ArrowRight" || e.key === "d" ? 1 : -1;
    let wrap = getEl("img" + index);
    if (!wrap) return;
    if (!this.state.visImgs.has(index)) wrap.scrollIntoView();
    this.hideCover();
    this.toggleZoom({ target: wrap.children[0] });
  }

  parseRatio() {
    let arr = [
      [" ", ""],
      ["—", "-"],
      ["--", "-"],
      [":", ":"],
    ]
      .reduce((t, r) => t.replaceAll(...r), this.ui.aspectratio.value)
      .split("-")
      .map((t, i) =>
        t === "" && i === 1
          ? Infinity
          : t
              .split(":")
              .map(Number)
              .reduce((p, c) => p / c)
      )
      .sort();
    [this.state.minR, this.state.maxR] = arr.concat(arr);
    this.reflow();
  }
}

// Initialize the app
const app = new MasonryViewer();
