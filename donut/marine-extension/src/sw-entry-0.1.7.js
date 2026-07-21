// Versioned MV3 entrypoint: changing this URL forces Chromium to replace a
// cached unpacked-extension worker when Marine upgrades the profile bundle.
importScripts('sw.js?v=0.1.7');
