/**
 * Find JSON files in a directory
 * @param {string} directory - Directory to search
 * @returns {Array<{name: string, filePath: string}>} - Array of JSON file info
 */
function findJsonFiles(directory) {
  const fs = require("fs");
  const path = require("path");

  try {
    const files = fs.readdirSync(directory);

    return files
      .filter((file) => path.extname(file).toLowerCase() === ".json")
      .map((file) => ({
        name: path.basename(file, ".json"),
        filePath: path.join(directory, file),
      }));
  } catch (error) {
    console.error(`Error reading directory: ${error.message}`);
    return [];
  }
}

module.exports = findJsonFiles;
