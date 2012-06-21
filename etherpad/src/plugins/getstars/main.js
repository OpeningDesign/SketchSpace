import("etherpad.log");
import("plugins.getstars.hooks");

function getstarsInit() {
 this.hooks = ['handlePath'];
 this.description = 'Converts a readwrite pad ID to a readonly one';
 this.handlePath = hooks.handlePath;

 this.install = install;
 this.uninstall = uninstall;
}

function install() {
 log.info("Installing getstars");
}

function uninstall() {
 log.info("Uninstalling getstars");
}
