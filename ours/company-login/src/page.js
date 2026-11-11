/**
 * The sign-in page: one static HTML document with a plain form post, so it
 * works before any client bundle loads and needs no other request.
 *
 * It is styled with the product's own `--dsw-*` tokens. The application
 * injects those tokens from its theme bundle at run time, so a page served
 * before sign-in cannot link them; the values the page uses are copied below.
 * They were read from the running application (computed values of the light
 * and dark themes, upstream tag dsh-v0.2.2-rc.1) and must be refreshed if the
 * product theme changes. Source: packages/client/ui-theme/src/styles/.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ESCAPES[ch])
}

const TOKENS = `
body.ours-login {
  --dsw-alias-bg-base: rgb(255, 255, 255);
  --dsw-alias-bg-layer-1: rgb(255, 255, 255);
  --dsw-alias-label-primary: rgb(15, 17, 21);
  --dsw-alias-label-secondary: rgb(97, 102, 107);
  --dsw-alias-label-primary-foreground: rgb(255, 255, 255);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l4: rgba(0, 0, 0, 0.16);
  --dsw-alias-state-business-primary: rgb(65, 118, 230);
  --dsw-alias-state-error-primary: rgb(236, 19, 19);
  --dsw-alias-button-primary-fill: rgb(15, 17, 21);
  --dsw-alias-button-primary-hover: rgb(67, 69, 74);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 12px;
  --dsw-radius-xl: 20px;
  --dsw-shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08);
  --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Helvetica Neue', Helvetica, Arial, sans-serif;
}
body.ours-login[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgb(21, 21, 23);
  --dsw-alias-bg-layer-1: rgb(35, 35, 36);
  --dsw-alias-label-primary: rgb(249, 250, 251);
  --dsw-alias-label-secondary: rgb(207, 211, 214);
  --dsw-alias-label-primary-foreground: rgb(15, 17, 21);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-border-l4: rgba(255, 255, 255, 0.2);
  --dsw-alias-state-business-primary: rgb(122, 170, 255);
  --dsw-alias-state-error-primary: rgb(242, 90, 90);
  --dsw-alias-button-primary-fill: rgb(249, 250, 251);
  --dsw-alias-button-primary-hover: rgb(235, 238, 242);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
}
`

export const COPY = {
  title: '로그인',
  lead: '회사 계정으로 로그인하세요.',
  username: '아이디',
  password: '비밀번호',
  submit: '로그인',
  invalid: '아이디 또는 비밀번호가 맞지 않습니다.',
  limited: minutes => `로그인 시도가 너무 많습니다. ${minutes}분 뒤에 다시 시도하세요.`,
  signedOut: '로그아웃했습니다.',
  expired: '로그인 시간이 끝났습니다. 다시 로그인하세요.',
}

const STYLE = `${TOKENS}
html, body { height: 100%; margin: 0; }
body.ours-login {
  display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%; max-width: 360px; box-sizing: border-box; padding: 32px 28px 28px;
  border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3);
}
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
.brand img { width: 32px; height: 32px; display: block; }
.brand span { font-size: 16px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
h1 { margin: 0 0 4px; font-size: 20px; line-height: 28px; font-weight: 600; }
.lead { margin: 0 0 20px; color: var(--dsw-alias-label-secondary); }
label { display: block; margin: 14px 0 6px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
input {
  display: block; width: 100%; height: 40px; box-sizing: border-box; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; outline: none;
}
input:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent); }
button {
  display: block; width: 100%; height: 40px; margin-top: 22px; border: none; cursor: pointer;
  border-radius: var(--dsw-radius-md); font: inherit; font-weight: 600;
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
}
button:hover { background: var(--dsw-alias-button-primary-hover); }
button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.notice { margin: 0 0 4px; padding: 8px 12px; border-radius: var(--dsw-radius-sm); font-size: 13px; line-height: 20px; }
.notice.error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.notice.info { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
`

// The application marks dark mode with a body attribute; before sign-in only the system setting is known.
const THEME_SCRIPT = `if (matchMedia('(prefers-color-scheme: dark)').matches) document.body.setAttribute('data-ds-dark-theme', '')`

/**
 * Render the page.
 * @param brand - `{ name, logoUri }`.
 * @param options - `notice` (`{ kind: 'error' | 'info', text }`), `username` (refill after a failure).
 */
export function renderLoginPage(brand, { notice, username = '' } = {}) {
  const noticeHtml = notice === undefined ? '' : `<p class="notice ${notice.kind === 'error' ? 'error' : 'info'}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(notice.text)}</p>`
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(COPY.title)} — ${escapeHtml(brand.name)}</title>
<link rel="icon" type="image/svg+xml" href="${escapeHtml(brand.logoUri)}" />
<style>${STYLE}</style>
</head>
<body class="ours-login">
<script>${THEME_SCRIPT}</script>
<main class="card">
<div class="brand"><img src="${escapeHtml(brand.logoUri)}" alt="" /><span>${escapeHtml(brand.name)}</span></div>
<h1>${escapeHtml(COPY.title)}</h1>
<p class="lead">${escapeHtml(COPY.lead)}</p>
${noticeHtml}
<form method="post" action="login" autocomplete="on">
<label for="username">${escapeHtml(COPY.username)}</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="128" value="${escapeHtml(username)}"${username === '' ? ' autofocus' : ''} />
<label for="password">${escapeHtml(COPY.password)}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"${username === '' ? '' : ' autofocus'} />
<button type="submit">${escapeHtml(COPY.submit)}</button>
</form>
</main>
</body>
</html>
`
}
