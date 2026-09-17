/// <reference types="vite/client" />

//  构建期环境变量（Vite 打包时静态替换）。
//  目前只用到 VITE_ICE_SERVERS：逗号分隔的 ICE 服务器列表，例 "stun:stun.qq.com"。
//  不配置 = 纯直连（仅同机/局域网）；配置后公网跨 NAT 也有机会 P2P 直连。
interface ImportMetaEnv {
  /** 逗号分隔的 ICE 服务器（stun:/turn:），见 deploy/README.md「P2P 直连」一节 */
  readonly VITE_ICE_SERVERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
