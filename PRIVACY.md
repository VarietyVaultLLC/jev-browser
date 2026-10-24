# Privacy policy: jev-browser

_Last updated: 2026-10-13_

jev-browser is an open-source library, CLI, MCP server and Claude Code plugin. It runs entirely on
your machine. The author operates no server for it, and it collects no analytics, telemetry or
crash reports.

## What leaves your machine

To decide what to click or type, jev-browser sends requests to the **TypeSafe System One API**
(`https://api.typesafe.ai`, model "Jev"), using the API key you provide. If you provide an
OpenRouter key instead, the same requests go to **OpenRouter** (`https://openrouter.ai`), which
passes them to TypeSafe. A request can contain:

- **Page content** of the page the browser is on: URL, title, visible text, and the interactive
  elements (their labels, text, placeholders, names, link targets and current values). For
  `browser_read`, it also contains blocks of the page's full text.
- **Your instructions:** the `goal` of a step, the recent actions taken toward it, and the
  questions you ask with `browser_check` and `browser_choose`.
- **The `values` you pass** for it to type or select, except:
  - values whose key names a secret (`password`, `pw`, `pwd`, `token`, `secret`, `otp`, `card`,
    `cvv`, `cvc`, `ssn`, `api_key`, `pin`), which are sent as their key name only;
  - values already typed into password fields, which are replaced by `[redacted]`.
  - a secret value (4 characters or more) that the page shows back, for example in its text or
    in a WebMCP tool's result, which is also replaced by `[redacted]`.

  The real values are typed locally by Playwright.

TypeSafe processes these requests under its own terms and privacy policy
(<https://docs.typesafe.ai>), and OpenRouter, when used, under its own
(<https://openrouter.ai/privacy>). jev-browser is not affiliated with either.

The browser also loads the websites you or your AI client direct it to, as any browser does.

## What stays on your machine

- **Screenshots and snapshots.** They are returned only to your MCP client, such as Claude Code.
  What that client does with them is governed by its own policy.
- **Your API key.** As a Claude Code plugin, the key is kept in Claude Code's secure credential
  store and passed to the local server as an environment variable. It is sent only to TypeSafe
  (or OpenRouter, for an OpenRouter key), as the `Authorization` header.
- **Browser data.** Cookies and logins live in a temporary profile that is discarded when the
  session ends, unless you set a persistent profile directory. In that case they stay in that
  directory.

## Children

jev-browser is a developer tool and is not directed at children under 18.

## Contact

Questions or concerns: open an issue at <https://github.com/Ying-Kai-Liao/jev-browser/issues>.
