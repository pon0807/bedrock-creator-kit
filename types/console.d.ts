// Minecraft のスクリプトで使える console（DOM の型を入れないプロジェクト用）
interface Console {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}
declare var console: Console;
