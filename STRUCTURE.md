# 项目概述

- **项目名称**：Masonry Image Viewer (瀑布流本地图片浏览器)
- **项目类型**：Web 应用 / PWA
- **主要语言**：JavaScript, HTML, CSS
- **技术栈**：原生 JavaScript (ES6+), File System Access API, Service Worker, IndexedDB, Intersection Observer API

---

## 目录结构

```
Masonry_Image_Viewer/
├── MasonryViewer.html     # 入口HTML文件
├── script.js              # 核心业务逻辑 (~1286行)
├── style.css              # 样式文件 (~434行)
├── sw.js                  # Service Worker (离线缓存)
├── app.webmanifest        # PWA配置清单
├── 192x192.png            # 应用图标
├── 512x512.png            # 应用图标
├── favicon.ico            # 网站图标
├── example1.png           # 文档示例图
├── example2.png           # 文档示例图
├── LICENSE                # 许可证
└── README.md              # 项目说明
```

---

## 功能模块

### 核心类：MasonryViewer
- **文件路径**：`script.js:233-1283`
- **功能描述**：主应用类，管理图片浏览器的完整生命周期
- **关键职责**：
  - 状态集中管理 (`state` 对象)
  - UI节点缓存与事件绑定
  - 图片加载与渲染调度
  - 布局模式切换 (瀑布流/横向流)

### 异步队列：Queue
- **文件路径**：`script.js:15-50`
- **功能描述**：轻量异步队列，作为目录扫描与图片加载之间的缓冲
- **关键方法**：`push()`, `shift()`, `process()`

### 图片尺寸读取：getWH()
- **文件路径**：`script.js:94-151`
- **功能描述**：低成本读取图片宽高，支持 PNG/GIF/BMP/WebP/JPEG
- **技术亮点**：直接解析文件头获取尺寸，性能远高于完整解码

### 文件导入系统
- **文件路径**：`script.js:600-680`
- **功能描述**：处理文件拖放、粘贴、选择器导入
- **关键方法**：`handleDrop()`, `handlePaste()`, `handleHintClick()`, `handleAddSourceClick()`

### 目录树系统
- **文件路径**：`script.js:846-885`, `script.js:481-518`
- **功能描述**：递归扫描目录结构，生成可交互的目录树
- **关键方法**：`handle()`, `jumpToDirectory()`

### 图片查看器
- **文件路径**：`script.js:1131-1260`
- **功能描述**：全屏查看、缩放、导航功能
- **关键方法**：`toggleZoom()`, `zoomImg()`, `moveImg()`, `naviZoom()`

### 过滤系统
- **文件路径**：`script.js:1063-1110`, `script.js:1262-1282`
- **功能描述**：黑白漫画检测、边框检测、宽高比过滤
- **关键方法**：`isMono()`, `isMonoBorder()`, `parseRatio()`

### 历史记录系统
- **文件路径**：`script.js:682-837`
- **功能描述**：使用 IndexedDB 持久化文件访问历史
- **关键方法**：`getHistoryDb()`, `saveFileListHistory()`, `renderFileListHistory()`

### 布局与样式
- **文件路径**：`style.css`
- **功能描述**：CSS 变量驱动的主题系统，支持瀑布流/横向流两种布局
- **关键特性**：CSS 变量动态控制间距、圆角、边框

### Service Worker
- **文件路径**：`sw.js`
- **功能描述**：静态资源离线缓存，采用 stale-while-revalidate 策略

---

## 依赖说明

本项目为纯前端应用，无外部依赖：

| 技术 | 用途 |
|------|------|
| File System Access API | 本地文件系统访问 |
| IndexedDB | 历史记录持久化存储 |
| Intersection Observer API | 视口检测与懒加载 |
| Service Worker | 离线缓存与 PWA 支持 |
| CSS Variables | 动态样式控制 |
| localStorage | 用户配置持久化 |

---

## 使用说明

### 运行方式
1. 使用 Chrome/Edge 浏览器直接打开 `MasonryViewer.html`
2. 点击页面中央或拖入图片文件夹
3. 程序自动递归扫描并渐进加载图片

### 主要配置项

| 配置项 | 说明 | 存储位置 |
|--------|------|----------|
| 列距/行距/圆角/边框 | 布局样式 | localStorage + CSS变量 |
| 列数/高度 | 布局模式参数 | localStorage |
| 排序字段/顺序 | 排序规则 | localStorage |
| 过滤按钮状态 | 过滤条件 | localStorage |

### 注意事项
- 需要支持 File System Access API 的浏览器
- 安卓端由于 API 限制不支持
- 大量图片时首次加载较慢属正常现象

