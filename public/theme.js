// Apply the saved theme before first paint. Default follows the system.
(function () {
  try {
    var t = localStorage.getItem('plan-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
