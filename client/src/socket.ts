import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * One socket for the whole app. It authenticates with the session cookie, so
 * there is nothing to pass here - the handshake either carries a valid cookie
 * or the server rejects the connection.
 */
export const getSocket = (): Socket => {
  if (!socket) {
    socket = io({
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
};

export const disconnectSocket = (): void => {
  socket?.disconnect();
  socket = null;
};

/** Promise wrapper over socket.io's ack callbacks. */
export const request = <T,>(event: string, payload: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    getSocket()
      .timeout(10000)
      .emit(event, payload, (err: Error | null, response: T) => {
        if (err) {
          reject(err);
          return;
        }
        const maybeError = (response as { error?: string })?.error;
        if (maybeError) {
          reject(new Error(maybeError));
          return;
        }
        resolve(response);
      });
  });
