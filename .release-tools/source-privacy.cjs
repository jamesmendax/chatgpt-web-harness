"use strict";
// Angle-bracket usernames are upstream documentation templates. Ordinary
// names, including names containing spaces, remain concrete profile paths.
const privateUserProfilePath = /[A-Za-z]:[\\/]+Users[\\/]+(?!\s*<[^<>\\/]+>\s*[\\/])[^\\/\r\n"'\x60]+[\\/]+AppData(?:[\\/]|$)/i;
module.exports = { privateUserProfilePath };
