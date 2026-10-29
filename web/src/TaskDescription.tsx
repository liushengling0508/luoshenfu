// 任务说明现在独占详情页左栏，滚动空间独立，不会再挤到右侧执行区，
// 因此不再需要「折叠/展开」：直接完整展示，长内容交给左栏自身滚动。
export function TaskDescription({ description }: { description: string }) {
  return (
    <div className="description-block">
      <div className="description-head"><b>任务说明</b></div>
      <p className="description">{description}</p>
    </div>
  );
}
