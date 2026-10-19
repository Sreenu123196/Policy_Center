'use strict';
// The error the API layer turns into a status code and a message. Its own module so the pieces mixed into PolicyCenter
// can throw it without importing the service (which would be a cycle).

class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = { AppError };
