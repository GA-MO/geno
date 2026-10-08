/**
 * Whether this run takes screenshots (GCODE_SCREENSHOTS names their folder). A suite's screenshot loop switches the
 * color theme three times and back, with a pause per switch for the window to repaint; without screenshots it
 * returns at once, since the webview tests check the themes.
 */
export const SHOOTING = process.env['GCODE_SCREENSHOTS'] !== undefined;
