// What ties this receiver to the media server and its senders.

/** The custom message namespace senders and this receiver talk on. */
export const NAMESPACE = 'urn:x-cast:com.mmcdole.kivo';

/** The debug log's namespace, used only with ?debug in the receiver's URL. */
export const DEBUG_NAMESPACE = 'urn:x-cast:com.mmcdole.kivo.debug';

/**
 * The version of the contract between senders, this receiver and the
 * server: the LOAD's customData, the status and messages here, and the
 * server's cast routes. The server states its own in server info.
 */
export const PROTOCOL = 2;

/** The app and platform this receiver names itself by in the Kivo-Client header. */
export const APP = 'kivo-cast';
export const PLATFORM = 'cast';

/** The receiver's version, as package.json gives it. */
export const VERSION = '2.0.0';
