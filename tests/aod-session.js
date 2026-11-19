// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = TEST_UUID;
const REFERENCE = IS_REFERENCE;
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
function check(value, text) { if (!value) throw new Error(text); }
async function until(predicate, text, timeout = 5000) {
    for (let waited = 0; waited < timeout; waited += 100) {
        if (predicate()) return;
        await delay(100);
    }
    throw new Error(text);
}

export default class Test extends Extension {
    enable() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this.run().catch(error => this.finish({ok: false, error: error.message, stack: error.stack}));
            return GLib.SOURCE_REMOVE;
        });
    }

    finish(result) { GLib.file_set_contents(RESULT_FILE, JSON.stringify(result)); }

    async run() {
        const extension = Main.extensionManager.lookup(UUID)?.stateObj;
        check(extension, 'Extension must load');
        const mode = REFERENCE ? extension._aod : extension._aodController;
        check(mode, 'Interactive controller must exist');
        const shield = Main.screenShield;
        const observations = {};
        const signalLog = [];
        const signal = shield.connect('active-changed', () => signalLog.push(shield._isActive));
        // Fake power properties only in this isolated compositor. No system
        // power service is changed, and no login/shutdown operation is invoked.
        const realPower = REFERENCE ? mode._powerProxy : mode.power;
        realPower.disconnectObject(mode);
        const power = {OnBattery: false, disconnectObject() {}};
        if (REFERENCE) mode._powerProxy = power;
        else mode.power = power;
        const active = () => REFERENCE ? mode._inAOD : mode.presenting;
        const overlay = () => REFERENCE ? mode._dimOverlay : mode.overlay;
        const powerChanged = () => REFERENCE ? mode._onPowerChanged() : mode.powerChanged();
        Main.overview.hide();
        await delay(300);
        shield.lock(false);
        check(shield.locked, 'Native lock path sets the locked state');
        await until(() => active(), 'AOD starts on activation');
        const background = shield._dialog._backgroundGroup;
        const transition = background.get_transition('opacity');
        observations.enterDuration = transition?.get_duration() ?? 0;
        observations.enterEasing = transition?.get_progress_mode() ?? null;
        await delay(1800);
        check(background.opacity === 0, 'Background reaches black');
        check(overlay()?.opacity === 153, 'Whole-screen overlay reaches 40% brightness');
        observations.idle = [background.opacity, overlay().opacity];
        observations.contentOpacity = shield._dialog._stack.get_parent().opacity;
        check(observations.contentOpacity === 255, 'No second opacity multiplier on content');
        const position = shield._dialog._stack.get_parent();
        observations.shiftWithinRadius = Math.hypot(position.translation_x, position.translation_y) <= 13;
        check(observations.shiftWithinRadius, 'OLED shift is within the configured radius');

        const pointer = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 200, 200);
        await until(() => !active(), 'Pointer activity exits dim mode');
        const exitTransition = background.get_transition('opacity');
        observations.exitDuration = exitTransition?.get_duration() ?? 0;
        observations.exitEasing = exitTransition?.get_progress_mode() ?? null;
        await delay(450);
        observations.interacting = [background.opacity, overlay().opacity];
        check(background.opacity === 255 && overlay().opacity === 0, 'Activity restores wallpaper and brightness');
        const started = GLib.get_monotonic_time();
        await until(() => active(), 'Returns to AOD after 10 seconds idle', 14000);
        observations.returnAfterIdle = (GLib.get_monotonic_time() - started) / 1000000;
        check(observations.returnAfterIdle >= 8 && observations.returnAfterIdle <= 12,
            'Idle interval is 10 seconds, allowing compositor scheduling');
        await delay(1700);

        // Simulate prompt page selection without starting an authentication
        // conversation. The controller must never dim a password prompt.
        const clockPage = shield._dialog._activePage;
        shield._dialog._activePage = shield._dialog._promptBox;
        shield._onUserBecameActive();
        await delay(450);
        if (REFERENCE) mode._enterAOD();
        else mode.show();
        check(!active(), 'Password page blocks entering AOD');
        observations.promptProtected = true;
        shield._dialog._activePage = clockPage;
        if (REFERENCE) mode._enterAOD();
        else mode.show();
        power.OnBattery = true;
        powerChanged();
        check(!active(), 'Unplugging exits AOD');
        check(signalLog.at(-1) === true, 'Battery blanking is announced');
        power.OnBattery = false;
        powerChanged();
        check(active(), 'Plugging in returns to AOD');
        shield.deactivate(false);
        await until(() => !shield._dialog && !shield._isActive, 'Unlock completes');
        check(signalLog.at(-1) === false, 'Unlock is announced after battery blanking');
        observations.powerSignals = [...signalLog];

        // Keyboard events must restore brightness too.
        shield.lock(false);
        await until(active, 'Second activation starts AOD');
        await delay(1700);
        const keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        await until(() => !active(), 'Keyboard activity exits AOD');
        await delay(450);
        check(overlay().opacity === 0, 'Keyboard restores normal brightness');
        observations.keyboardRestores = true;
        // Starting a lock while on battery must retain the AC-only policy.
        shield.deactivate(false);
        await until(() => !shield._dialog, 'Second unlock completes');
        power.OnBattery = true;
        shield.lock(false);
        await delay(300);
        check(!active(), 'Initial battery lock does not enter AOD');
        observations.initialBatteryLockBlanksNormally = true;
        power.OnBattery = false;
        powerChanged();
        await until(active, 'Connecting AC during battery lock starts the clock');
        await delay(1700);
        check(shield._dialog._clock.visible, 'Clock actor remains visible on AC');
        check(shield._dialog._stack.get_parent().opacity === 255, 'Clock content remains fully opaque under overlay');
        observations.clockVisibleOnAc = true;
        // Cancel watches and animations when disabled while a dialog exists.
        extension.disable();
        check(!overlay(), 'Disabling destroys the dimming overlay');
        shield.disconnect(signal);
        shield.deactivate(false);
        await delay(700);
        extension.enable();
        check(REFERENCE ? extension._aod : extension._aodController, 'Re-enable succeeds');
        observations.cleanupAndReenable = true;
        this.finish({ok: true, observations});
    }

    disable() {}
}
