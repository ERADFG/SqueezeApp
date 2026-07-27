/* =========================================================================
   InteractInk — Light / Dark theme controller
   - Preference is one of 'system' | 'dark' | 'light', saved in localStorage.
   - Default preference is 'system' (follows the phone/browser setting),
     but if the system setting can't be read, we fall back to dark, since
     that's the site's native design.
   - The tiny inline snippet in <head> (added to every page) applies the
     theme attribute before first paint to avoid a flash of the wrong theme;
     this file provides the full controller + toggle UI + logo swapping.
   ========================================================================= */
(function () {
    var STORAGE_KEY = 'ink-theme-preference';
    var DARK_LOGO = 'favicon2.png';
    var LIGHT_LOGO = 'logo2.png';

    function getPreference() {
        try {
            return localStorage.getItem(STORAGE_KEY) || 'system';
        } catch (e) {
            return 'system';
        }
    }

    function systemPrefersLight() {
        try {
            var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
            var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
            if (light && light.matches) return true;
            if (dark && dark.matches) return false;
        } catch (e) {}
        return false; // unknown -> fall back to dark
    }

    function resolveTheme(pref) {
        if (pref === 'light') return 'light';
        if (pref === 'dark') return 'dark';
        return systemPrefersLight() ? 'light' : 'dark';
    }

    function swapLogos(theme) {
        var target = theme === 'light' ? LIGHT_LOGO : DARK_LOGO;
        var other = theme === 'light' ? DARK_LOGO : LIGHT_LOGO;
        var imgs = document.querySelectorAll('img[src="' + DARK_LOGO + '"], img[src="' + LIGHT_LOGO + '"], img[src$="/' + DARK_LOGO + '"], img[src$="/' + LIGHT_LOGO + '"]');
        imgs.forEach(function (img) {
            var src = img.getAttribute('src');
            if (src.indexOf(other) !== -1) {
                img.setAttribute('src', src.replace(other, target));
            }
        });
    }

    function updateToggleUI(pref) {
        document.querySelectorAll('[data-theme-option]').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-theme-option') === pref);
        });
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        swapLogos(theme);
        updateToggleUI(getPreference());
    }

    function setPreference(pref) {
        try { localStorage.setItem(STORAGE_KEY, pref); } catch (e) {}
        applyTheme(resolveTheme(pref));
    }

    function refresh() {
        applyTheme(resolveTheme(getPreference()));
    }

    window.InkTheme = {
        setPreference: setPreference,
        getPreference: getPreference,
        resolveTheme: resolveTheme,
        refresh: refresh
    };

    // Follow live system changes, but only while the user hasn't overridden it.
    try {
        var mqLight = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () { if (getPreference() === 'system') refresh(); };
        if (mqLight.addEventListener) mqLight.addEventListener('change', onChange);
        else if (mqLight.addListener) mqLight.addListener(onChange);
    } catch (e) {}

    // Keep multiple open tabs in sync.
    window.addEventListener('storage', function (e) {
        if (e.key === STORAGE_KEY) refresh();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refresh);
    } else {
        refresh();
    }
})();
