// SPDX-License-Identifier: MIT
// Optional interactive presentation for Unblank's lock screen.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {UnlockDialog} from 'resource:///org/gnome/shell/ui/unlockDialog.js';
import {OledShift} from './oledShift.js';

const PowerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="org.freedesktop.UPower">
<property name="OnBattery" type="b" access="read"/>
</interface></node>`);
const DisplayProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="org.gnome.Mutter.DisplayConfig">
<property name="PowerSaveMode" type="i" access="readwrite"/>
</interface></node>`);

export class AodMode {
    constructor(settings) {
        this.settings = settings;
        this.shift = new OledShift(settings);
        this.idle = global.backend.get_core_idle_monitor();
        this.presenting = false;
        this.locked = false;
        this.idleWatch = 0;
        this.activeWatch = 0;
        this.promptWatch = 0;
        this.timeout = 0;
        this.overlay = null;
        this.hooks = null;
        this.savedStyle = null;
        this.dimState = null;
    }

    enable() {
        const shield = Main.screenShield;
        this.announced = shield._isActive;
        this.hooks = new InjectionManager();
        this.power = new PowerProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower', (proxy, error) => {
                if (error || !this.hooks)
                    return;
                proxy.connectObject('g-properties-changed', () => this.powerChanged(), this);
                this.powerChanged();
            });
        this.display = new DisplayProxy(Gio.DBus.session, 'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig', () => {});
        const mode = this;
        this.hooks.overrideMethod(shield, '_setActive', () => function (active) {
            const changed = this._isActive !== active;
            this._isActive = active;
            mode.locked = active;
            if (active && mode.allowed())
                mode.show();
            else if (!active)
                mode.hide(false);
            if (changed)
                mode.announce(active);
            this._syncInhibitor();
        });
        this.hooks.overrideMethod(shield, '_activateFade', original => function (box, time) {
            if (mode.locked && mode.allowed())
                mode.show();
            else
                original.call(this, box, time);
        });
        this.hooks.overrideMethod(shield, '_resetLockScreen', original => function (params) {
            original.call(this, {...params, fadeToBlack: params.fadeToBlack && !mode.allowed()});
        });
        this.hooks.overrideMethod(shield, '_onUserBecameActive', original => function () {
            original.call(this);
            if (mode.presenting)
                mode.hide(true);
        });
        this.savedStyle = shield._lockDialogGroup.get_style();
        this.setBacking();
        if (shield._refreshBackground) {
            this.hooks.overrideMethod(shield, '_refreshBackground', original => function () {
                original.call(this);
                mode.setBacking();
            });
        }
        if (UnlockDialog.prototype._showClock) {
            this.hooks.overrideMethod(UnlockDialog.prototype, '_showClock', original => function () {
                original.call(this);
                mode.waitForIdle();
            });
        }
    }

    setBacking() {
        Main.screenShield._lockDialogGroup.set_style('background-color: black;');
    }

    allowed() {
        return !(this.settings.get_boolean('power') && this.power.OnBattery);
    }

    onPrompt() {
        const dialog = Main.screenShield._dialog;
        return !!dialog && dialog._activePage === dialog._promptBox;
    }

    announce(active) {
        if (this.announced === active || (active && this.allowed()))
            return;
        Main.screenShield.emit('active-changed');
        this.announced = active;
    }

    powerChanged() {
        if (!this.locked)
            return;
        if (!this.allowed()) {
            this.hide(false);
            this.announce(true);
        } else if (!this.presenting) {
            this.display.PowerSaveMode = 0;
            this.show();
        }
    }

    show() {
        if (this.presenting || !this.locked)
            return;
        if (this.onPrompt()) {
            this.waitForIdle();
            return;
        }
        this.presenting = true;
        Main.screenShield._longLightbox.lightOff();
        Main.screenShield._shortLightbox.lightOff();
        this.background(0, this.settings.get_int('aod-fade-in'));
        this.darken();
        this.clearWatches();
        this.shift.start({appearance: false});
        this.activeWatch = this.idle.add_user_active_watch(() => {
            this.activeWatch = 0;
            this.hide(true);
        });
        const seconds = this.settings.get_int('time');
        if (seconds > 0) {
            this.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this.timeout = 0;
                this.hide(false);
                this.announce(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    hide(animate) {
        this.presenting = false;
        this.shift.stop();
        const duration = animate ? this.settings.get_int('aod-fade-out') : 0;
        this.background(255, duration);
        if (this.overlay)
            this.fade(this.overlay, 0, duration, Clutter.AnimationMode.EASE_IN_QUAD);
        this.restoreBrightness();
        if (this.timeout) {
            GLib.Source.remove(this.timeout);
            this.timeout = 0;
        }
        this.clearWatches();
        if (animate)
            this.waitForIdle();
    }

    fade(actor, opacity, duration, mode) {
        actor.remove_transition('opacity');
        if (duration)
            actor.ease({opacity, duration, mode});
        else
            actor.opacity = opacity;
    }

    background(opacity, duration) {
        const actor = Main.screenShield._dialog?._backgroundGroup;
        if (actor)
            this.fade(actor, opacity, duration, opacity ? Clutter.AnimationMode.EASE_IN_QUAD : Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    darken() {
        const fraction = this.settings.get_int('aod-brightness') / 100;
        if (!this.settings.get_boolean('aod-software-dimming')) {
            const manager = Main.brightnessManager;
            if (manager?.globalScale) {
                this.dimState = {manager, enabled: manager.dimming, target: manager._dimmingTarget};
                if (typeof manager._dimmingTarget === 'number')
                    manager._dimmingTarget = manager.globalScale.value * fraction;
                manager.dimming = true;
            }
            return;
        }
        if (!this.overlay) {
            this.overlay = new St.Widget({style: 'background-color: black;', opacity: 0, reactive: false});
            this.overlay.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
            Main.uiGroup.add_child(this.overlay);
        }
        Main.uiGroup.set_child_above_sibling(this.overlay, null);
        this.fade(this.overlay, Math.round(255 * (1 - fraction)),
            this.settings.get_int('aod-fade-in'), Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    restoreBrightness() {
        if (!this.dimState)
            return;
        const {manager, enabled, target} = this.dimState;
        manager._dimmingTarget = target;
        manager.dimming = enabled;
        this.dimState = null;
    }

    clearWatches() {
        for (const key of ['idleWatch', 'activeWatch', 'promptWatch']) {
            if (this[key]) {
                this.idle.remove_watch(this[key]);
                this[key] = 0;
            }
        }
    }

    waitForIdle() {
        this.clearWatches();
        if (!this.locked || this.presenting)
            return;
        if (this.onPrompt()) {
            this.promptWatch = this.idle.add_user_active_watch(() => {
                this.promptWatch = 0;
                this.waitForIdle();
            });
        } else {
            this.idleWatch = this.idle.add_idle_watch(this.settings.get_int('aod-idle-delay') * 1000, () => {
                this.clearWatches();
                if (this.allowed())
                    this.show();
            });
        }
    }

    disable() {
        this.hooks.clear();
        this.hooks = null;
        this.power.disconnectObject(this);
        this.locked = false;
        this.hide(false);
        this.overlay?.destroy();
        this.overlay = null;
        Main.screenShield._lockDialogGroup.set_style(this.savedStyle);
        Main.screenShield._refreshBackground?.();
    }
}
