# Dashboard JS modules

`dashboard.js` remains the main SPA controller. Shared polish and gradual extraction live here so we do not rewrite the whole file at once.

| File | Role |
|------|------|
| `../site-polish.js` | Loading rows, empty states, skeletons, mobile table labels, scroll-top, ripples |
| `dialogs.js` | Shared open/close helpers for confirm / messaging overlays |
| `dashboard-enhancements.js` | Patches `DashboardApp` after load (account skeletons, Analytics/Maps sparse banners) |

## Safe modularization rule

- Prefer **patch / enhance** over moving 14k lines in one PR
- Keep green + coffee UI tokens unchanged
- New feature helpers should land in `js/modules/` and register via `window.DashboardApp.prototype` or `window.BeanthenticUI`
