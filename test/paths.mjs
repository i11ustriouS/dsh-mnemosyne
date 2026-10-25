/**
 * 测试脚本的公共路径解析。
 *
 * 所有脚本都要读写「记忆女神数据目录」，而它依赖 DSH 环境。
 * 把解析集中在这里，避免每个脚本各写一份硬编码路径（也避免把个人机器路径带进仓库）。
 *
 * 解析顺序：
 *   1. MV_DATA_DIR —— 直接指定数据目录（最高优先，便于测试隔离）
 *   2. DSH_HOME/mnemosyne —— DSH 标准位置
 *   3. 当前用户目录下的 .dsh/mnemosyne —— 常见回退
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 记忆女神数据目录。 */
export function resolveDataDir() {
  const explicit = process.env.MV_DATA_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();

  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === "string" && dshHome.trim() !== "") {
    return join(dshHome.trim(), "mnemosyne");
  }

  return join(homedir(), ".dsh", "mnemosyne");
}

/**
 * 记忆库数据目录，并在缺失时给出可读的提示。
 * @param {{ create?: boolean }} [options]
 */
export function requireDataDir(options = {}) {
  const dir = resolveDataDir();
  if (!existsSync(dir) && options.create !== true) {
    console.error(`找不到记忆库数据目录：${dir}`);
    console.error("请先设置环境变量 DSH_HOME（DSH 状态根），或用 MV_DATA_DIR 直接指定数据目录。");
    process.exit(1);
  }
  return dir;
}