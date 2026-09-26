// shown the moment a hive is clicked, while its tools, feed and workers load from atlas (the tool page uses the same skeleton)
export default function Loading() {
  return (
    <main className="wide fit">
      <div className="loading-sk" aria-busy="true" aria-label="loading hive">
        <div className="sk sk-title" />
        <div className="sk-cols"><div className="sk sk-block" /><div className="sk sk-block" /></div>
      </div>
    </main>
  );
}
