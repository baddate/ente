import AutoLaunch from 'auto-launch';
import { AutoLauncherClient } from '../../types/autoLauncher';

class LinuxAutoLauncher implements AutoLauncherClient {
    private instance: AutoLaunch;
    constructor() {
        const autoLauncher = new AutoLaunch({
            name: 'ente',
            isHidden: true,
        });
        this.instance = autoLauncher;
    }
    async isEnabled() {
        return await this.instance.isEnabled();
    }
    async toggleAutoLaunch() {
        if (await this.isEnabled()) {
            await this.instance.disable();
        } else {
            await this.instance.enable();
        }
    }
}

export default new LinuxAutoLauncher();
