import { buildBatchGraph } from "./graph.js";

// Studio 仅查看图结构。业务运行必须由持有租约的 EventRunner 发起。
const unavailable = (): never => {
  throw new Error("Studio graph is read-only; run governance through EventRunner");
};

export const graph = buildBatchGraph({
  loadContext: async () => unavailable(),
  research: async () => unavailable(),
  onNode: async () => unavailable(),
});
