/**
 * G2-e-3 (2026-05-31): 別コンポーネント (オンボーディングモーダル等) から
 * 画面右下のチャット FAB を「ヘルプ・ガイド」タブで開くための薄い橋渡し。
 *
 * チャットは FAB に一本化しているため ([[feedback_worldview_scope_onboarding_chat_only]])、
 * モーダルの「たすきフクロウに聞いてみる」CTA は画面遷移せずこの関数で FAB を開く。
 *
 * しくみ:
 *   1. ChatPanel が参照する mode の sessionStorage キーを 'help' にしておく
 *      (FAB が開いた瞬間に ChatPanel が loadPanelMode() で help タブを選ぶ)。
 *   2. カスタムイベントを dispatch し、ChatSemanticSearchFab がそれを購読して open する。
 */

/** ChatSemanticSearchFab が購読するイベント名。 */
export const OPEN_HELP_CHAT_EVENT = 'tasukiba:open-help-chat';

/** chat-panel.tsx の PANEL_MODE_STORAGE_KEY と一致させること (mode の復元元)。 */
const PANEL_MODE_STORAGE_KEY = 'tasukiba_chat_panel_mode_v1';

/** チャット FAB を「ヘルプ・ガイド」タブで開くよう要求する (SSR safe)。 */
export function requestOpenHelpChat(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PANEL_MODE_STORAGE_KEY, 'help');
  } catch {
    // private browsing / quota 超過時は無視 (FAB は開く)
  }
  window.dispatchEvent(new CustomEvent(OPEN_HELP_CHAT_EVENT));
}
