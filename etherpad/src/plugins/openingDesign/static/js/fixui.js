$(document).ready(function () {
  var e = jQuery.Event('mousedown');
  e.pageX = 0; $('#vdraggie').trigger(e);
  e = jQuery.Event('mouseup');
  e.pageX = 0; $('#vdraggie').trigger(e);
});

(function() {
  var uv = document.createElement('script'); uv.type = 'text/javascript'; uv.async = true;
  uv.src = ('https:' == document.location.protocol ? 'https://' : 'http://') + 'widget.uservoice.com/ZE1Z0qGJ6pPV2tTPyMfYCQ.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(uv, s);
})();

var _gaq = _gaq || [];
_gaq.push(['_setAccount', 'UA-23480461-1']);
_gaq.push(['_trackPageview']);

(function() {
  var ga = document.createElement('script'); ga.type = 'text/javascript'; ga.async = true;
  ga.src = ('https:' == document.location.protocol ? 'https://ssl' : 'http://www') + '.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);
})();

