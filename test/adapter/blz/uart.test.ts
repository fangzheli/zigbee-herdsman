import { SerialDriver } from '../../../src/adapter/blz/driver/uart';
import { Frame } from '../../../src/adapter/blz/driver/frame';
import { SerialPortOptions } from '../../../src/adapter/tstype';

describe('SerialDriver', () => {
    let driver: SerialDriver; // Declare the driver variable

    // Create a new driver instance before each test
    beforeEach(() => {
        driver = new SerialDriver();
    });

    // Close the driver after each test
    afterEach(async () => {
        if (driver.isInitialized()) {
            await driver.close(true); // Ensure resources are cleaned up
        }
    });

    it('should open a serial port connection and reset the NCP', async () => {
        const options: SerialPortOptions = {
            path: '/dev/ttyUSB0', // Replace with your serial port path
            baudRate: 115200,
            rtscts: true,
        };

        await expect(driver.connect(options)).resolves.not.toThrow();
        expect(driver.isInitialized()).toBe(true);
    });
});
