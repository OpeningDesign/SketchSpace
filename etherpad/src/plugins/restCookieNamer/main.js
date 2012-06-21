import("etherpad.log");
import("plugins.restCookieNamer.hooks");

function restCookieNamerInit() {
 this.hooks = ['assignName'];
 this.description = 'Assigns names using an external service and a cookieOA.';
 this.assignName = hooks.assignName;
 this.install = install;
 this.uninstall = uninstall;
}

function install() {
 log.info("Installing");
}

function uninstall() {
 log.info("Uninstalling");
}
