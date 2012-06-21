import("etherpad.log");
import("dispatch.{Dispatcher,PrefixMatcher,forward}");
import("plugins.rwtoro.controller");
import("sqlbase.sqlobj");

function handlePath() {
  return [[PrefixMatcher('/ep/rwtoro'), forward(controller)]];
}
