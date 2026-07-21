// Versioned registration URL forces Chromium to install the bundled worker
// update even when the shared implementation path stays the same.
importScripts('sw.js?v=0.1.8');
