import fs from "fs";
import https from "https";
import { URL } from "url";
import { exec } from "child_process";
import { format, subHours, differenceInHours, parseISO } from "date-fns";
import { promisify } from "util";

const baseDir = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl";

interface GribDataResponse {
  stamp: string | false;
  targetDate: Date | false;
  downloaded: boolean;
}

export class GribService {
  private static roundHours(date: Date, interval: number): string {
    const hours = date.getUTCHours();
    const roundedHours = Math.floor(hours / interval) * interval;
    return roundedHours.toString().padStart(2, "0");
  }

  private static formatDateStamp(date: Date): string {
    return format(date, "yyyyMMdd") + this.roundHours(date, 6);
  }

  static async getLatestAvailableTimestamp(): Promise<Date> {
    // This is a placeholder implementation. You'll need to adapt this
    // based on how you can query the NOAA server for the latest data.
    const now = new Date();
    const roundedNow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Math.floor(now.getHours() / 6) * 6
    );
    return subHours(roundedNow, 6); // Assume data is 6 hours behind current time
  }

  static async getGribData(targetDate: Date): Promise<GribDataResponse> {
    const latestAvailable = await this.getLatestAvailableTimestamp();
    if (targetDate > latestAvailable) {
      console.log(
        `Data for ${format(targetDate, "yyyy-MM-dd HH:mm")} not available yet. Using latest available: ${format(latestAvailable, "yyyy-MM-dd HH:mm")}`
      );
      targetDate = latestAvailable;
    }

    const runQuery = async (
      currentDate: Date,
      retryCount = 0
    ): Promise<GribDataResponse> => {
      if (
        (new Date().getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24) >
        10
      ) {
        console.log(
          "Hit limit, harvest complete or there is a big gap in data.."
        );
        return { stamp: false, targetDate: false, downloaded: false };
      }

      const stamp_label = this.formatDateStamp(currentDate);
      const stamp = `${format(currentDate, "yyyyMMdd")}/${this.roundHours(currentDate, 6)}/atmos`;

      const params = new URLSearchParams({
        file: `gfs.t${this.roundHours(currentDate, 6)}z.pgrb2.1p00.f000`,
        lev_10_m_above_ground: "on",
        lev_surface: "on",
        var_TMP: "on",
        var_UGRD: "on",
        var_VGRD: "on",
        leftlon: "0",
        rightlon: "360",
        toplat: "90",
        bottomlat: "-90",
        dir: `/gfs.${stamp}`,
      });

      const url = new URL(`${baseDir}?${params}`);

      return new Promise((resolve, reject) => {
        https
          .get(url, (response) => {
            if (response.statusCode !== 200) {
              console.log(
                `Failed to fetch data for ${stamp_label}, status: ${response.statusCode}`
              );
              if (retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000;
                console.log(`Retrying in ${delay}ms...`);
                setTimeout(() => {
                  runQuery(currentDate, retryCount + 1)
                    .then(resolve)
                    .catch(reject);
                }, delay);
              } else {
                runQuery(subHours(currentDate, 6)).then(resolve).catch(reject);
              }
              return;
            }

            if (!this.checkPath(`json-data/${stamp_label}.json`, false)) {
              console.log(`Downloading ${stamp_label}`);
              this.checkPath("grib-data", true);

              const writer = fs.createWriteStream(
                `grib-data/${stamp_label}.f000`
              );
              response.pipe(writer);

              writer.on("finish", () => {
                console.log(`Successfully downloaded ${stamp_label}`);
                resolve({
                  stamp: stamp_label,
                  targetDate: currentDate,
                  downloaded: true,
                });
              });
              writer.on("error", (err) => {
                console.error(`Error writing file ${stamp_label}: ${err}`);
                reject(err);
              });
            } else {
              console.log(`Already have ${stamp_label}, not looking further`);
              resolve({
                stamp: stamp_label,
                targetDate: currentDate,
                downloaded: false,
              });
            }
          })
          .on("error", (error) => {
            console.error(
              `Error fetching GRIB data for ${stamp_label}:`,
              error
            );
            if (retryCount < 3) {
              const delay = Math.pow(2, retryCount) * 1000;
              console.log(`Retrying in ${delay}ms...`);
              setTimeout(() => {
                runQuery(currentDate, retryCount + 1)
                  .then(resolve)
                  .catch(reject);
              }, delay);
            } else {
              runQuery(subHours(currentDate, 6)).then(resolve).catch(reject);
            }
          });
      });
    };

    return runQuery(targetDate);
  }

  static async convertGribToJson(
    stamp: string,
    targetDate: Date
  ): Promise<void> {
    this.checkPath("json-data", true);

    const inputFile = `grib-data/${stamp}.f000`;
    const outputFile = `json-data/${stamp}.json`;

    if (!fs.existsSync(inputFile)) {
      console.error(
        `Input file ${inputFile} does not exist. Attempting to re-download.`
      );
      const response = await this.getGribData(targetDate);
      if (response.stamp && response.downloaded) {
        return this.convertGribToJson(
          response.stamp,
          response.targetDate as Date
        );
      }
      throw new Error(`Failed to download data for ${stamp}`);
    }

    const execPromise = promisify(exec);

    try {
      await execPromise(
        `converter/bin/grib2json --data --output ${outputFile} --names --compact ${inputFile}`
      );
      console.log(`Successfully converted ${stamp}`);
      fs.unlinkSync(inputFile);
    } catch (error) {
      console.error(`Error converting ${stamp}:`, error);
      throw error;
    }

    const prevDate = subHours(targetDate, 6);
    const prevStamp = this.formatDateStamp(prevDate);

    if (!this.checkPath(`json-data/${prevStamp}.json`, false)) {
      console.log(`Attempting to harvest older data ${prevStamp}`);
      try {
        const response = await this.getGribData(prevDate);
        if (response.stamp && response.downloaded) {
          await this.convertGribToJson(
            response.stamp,
            response.targetDate as Date
          );
        }
      } catch (error) {
        console.error(`Error harvesting older data ${prevStamp}:`, error);
      }
    } else {
      console.log("Got older, no need to harvest further");
    }
  }

  private static checkPath(path: string, mkdir: boolean): boolean {
    try {
      fs.statSync(path);
      return true;
    } catch (e) {
      if (mkdir) {
        fs.mkdirSync(path, { recursive: true });
      }
      return false;
    }
  }

  static cleanupFiles(): void {
    const jsonFiles = fs
      .readdirSync("json-data")
      .filter((file) => file.endsWith(".json"));
    const gribFiles = fs
      .readdirSync("grib-data")
      .filter((file) => file.endsWith(".f000"));

    jsonFiles.forEach((jsonFile) => {
      const stamp = jsonFile.replace(".json", "");
      const gribFile = `${stamp}.f000`;
      if (!gribFiles.includes(gribFile)) {
        console.log(`Deleting orphaned JSON file: ${jsonFile}`);
        fs.unlinkSync(`json-data/${jsonFile}`);
      }
    });

    gribFiles.forEach((gribFile) => {
      const stamp = gribFile.replace(".f000", "");
      const jsonFile = `${stamp}.json`;
      if (!jsonFiles.includes(jsonFile)) {
        console.log(`Deleting orphaned GRIB file: ${gribFile}`);
        fs.unlinkSync(`grib-data/${gribFile}`);
      }
    });
  }

  static checkDataFreshness(maxAgeHours: number = 24): void {
    const jsonFiles = fs
      .readdirSync("json-data")
      .filter((file) => file.endsWith(".json"));

    jsonFiles.forEach((jsonFile) => {
      const stats = fs.statSync(`json-data/${jsonFile}`);
      const fileAge = differenceInHours(new Date(), stats.mtime);

      if (fileAge > maxAgeHours) {
        console.log(
          `Data for ${jsonFile} is older than ${maxAgeHours} hours. Re-downloading.`
        );
        const stamp = jsonFile.replace(".json", "");
        const date = parseISO(
          `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:00:00Z`
        );
        this.getGribData(date)
          .then((response) => {
            if (response.stamp && response.downloaded) {
              this.convertGribToJson(
                response.stamp,
                response.targetDate as Date
              );
            }
          })
          .catch((error) => {
            console.error(`Error re-downloading data for ${stamp}:`, error);
          });
      }
    });
  }
}
