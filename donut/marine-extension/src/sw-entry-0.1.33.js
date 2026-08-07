// Versioned MV3 entrypoint: changing this URL forces Chromium to replace a
// cached unpacked-extension worker when Marine upgrades the profile bundle.
//
// Renaming this file is the ONLY thing that works. Measured against Wayfern
// 150.0.7871.102 with a persistent profile and a full browser restart between
// runs: editing the imported `sw.js` alone keeps the old worker; editing it AND
// bumping the manifest version ALSO keeps the old worker; renaming this entry
// replaces it. Three consecutive sw.js-only fixes shipped as silent no-ops
// before that was noticed — `bundled_manifest_versions_worker_registration_url`
// now hashes sw.js so the next one cannot.
importScripts('sw.js?v=0.1.33');
