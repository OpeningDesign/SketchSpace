import { createHmac, timingSafeEqual } from "node:crypto";

import { parse as parseCookie, serialize as serializeCookie } from "cookie";

import { config } from "./config.js";

import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "sketchspace_session";

const sign = (payload: string): string =>
  createHmac("sha256", config.sessionSecret).update(payload).digest("hex");

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

export const checkPassword = (candidate: unknown): boolean =>
  typeof candidate === "string" && safeEqual(candidate, config.password);

export const issueToken = (): string => {
  const issuedAt = Date.now().toString();
  return `${issuedAt}.${sign(issuedAt)}`;
};

export const verifyToken = (token: string | undefined): boolean => {
  if (!token) {
    return false;
  }
  const [issuedAt, signature] = token.split(".");
  if (!issuedAt || !signature) {
    return false;
  }
  if (!safeEqual(signature, sign(issuedAt))) {
    return false;
  }
  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < config.sessionMaxAgeMs;
};

export const sessionCookie = (token: string): string =>
  serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(config.sessionMaxAgeMs / 1000),
    // Not `secure: true` unconditionally - self-hosted instances are commonly
    // reached over plain http on a LAN, and a secure cookie would silently
    // never be sent. Put a TLS terminator in front for anything public.
    secure: process.env.SKETCHSPACE_SECURE_COOKIE === "true",
  });

export const clearCookie = (): string =>
  serializeCookie(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });

export const tokenFromCookieHeader = (
  header: string | undefined,
): string | undefined => {
  if (!header) {
    return undefined;
  }
  return parseCookie(header)[COOKIE_NAME];
};

export const isAuthed = (req: { headers: { cookie?: string } }): boolean =>
  verifyToken(tokenFromCookieHeader(req.headers.cookie));

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!isAuthed(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};
