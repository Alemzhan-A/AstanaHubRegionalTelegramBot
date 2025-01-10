const fs = require('fs').promises;
const path = require('path');

class Logger {
  constructor() {
    this.logDir = 'logs';
    this.currentLogFile = '';
    this.init();
  }

  async init() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      this.updateLogFile();
    } catch (error) {
      console.error('Error initializing logger:', error);
    }
  }

  updateLogFile() {
    const date = new Date();
    const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.log`;
    this.currentLogFile = path.join(this.logDir, fileName);
  }

  async log(message, type = 'INFO') {
    try {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [${type}] ${message}\n`;

      // Вывод в консоль
      console.log(logMessage.trim());

      // Проверяем, нужно ли создать новый файл лога
      this.updateLogFile();

      // Записываем в файл
      await fs.appendFile(this.currentLogFile, logMessage);
    } catch (error) {
      console.error('Error writing to log file:', error);
    }
  }

  async error(message, error) {
    const errorMessage = error ? `${message}: ${error.message}\n${error.stack}` : message;
    await this.log(errorMessage, 'ERROR');
  }

  async info(message) {
    await this.log(message, 'INFO');
  }

  async warning(message) {
    await this.log(message, 'WARNING');
  }

  async debug(message) {
    if (process.env.DEBUG) {
      await this.log(message, 'DEBUG');
    }
  }
}

module.exports = new Logger(); 