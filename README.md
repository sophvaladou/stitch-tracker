# Stitch Tracker

A personal knitting pattern tracker, similar to knitCompanion. Upload a PDF pattern, pick the pages you need, and keep your place with a sliding row marker and stitch marker. You can also draw on the pattern and keep notes.

Everything runs in the browser. Patterns and progress are stored on the device and never uploaded anywhere.

## Use it

- **Locally:** open `index.html` in Chrome or Edge.
- **On a phone:** host the folder on GitHub Pages, open the link, and choose *Add to Home Screen*. It then works like an app, including offline.

## Moving patterns between devices

Each device keeps its own data. To copy patterns across, tap **⬇ Backup** in the library on one device, then **⬆ Restore** with that file on the other.

## Updating

After changing files, bump `VERSION` in `sw.js` so phones pick up the new version.
