import("etherpad.log");
import("plugins.rwtoro.hooks");

function rwtoroInit() {
 this.hooks = ['handlePath'];
 this.description = 'Converts a readwrite pad ID to a readonly one';
 this.handlePath = hooks.handlePath;

 this.install = install;
 this.uninstall = uninstall;
}

function install() {
 log.info("Installing rwtoro");
}

function uninstall() {
 log.info("Uninstalling rwtoro");
}
