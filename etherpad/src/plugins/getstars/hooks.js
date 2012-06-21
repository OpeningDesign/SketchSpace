import("etherpad.log");
import("dispatch.{Dispatcher,PrefixMatcher,forward}");
import("plugins.getstars.controller");
import("sqlbase.sqlobj");

function handlePath() {
  return [[PrefixMatcher('/ep/getstars'), forward(controller)]];
}
