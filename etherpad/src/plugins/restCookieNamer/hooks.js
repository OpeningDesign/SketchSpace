import("etherpad.log");
import("etherpad.utils.*");
import("fastJSON");

function readUrl(url) {
  var f = new java.io.BufferedReader(new java.io.InputStreamReader(new java.net.URL(url).openStream()));
  var res = '';
  var len;
  var cbuf = java.lang.reflect.Array.newInstance(java.lang.Character.TYPE, 1024);

  while ((len = f.read(cbuf, 0, 1024)) != -1) {
    res += new java.lang.String(cbuf, 0, len);
  }

  f.close();

  return res;
}

function assignName(args) {
  return [readUrl("http://staging.openingdesign.com/profile/display_name?cookie=" + encodeURIComponent(request.cookies['OD_COOKIE']))];
}
