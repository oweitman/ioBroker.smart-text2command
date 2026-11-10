import React from 'react';
import { Box, StyledEngineProvider } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { GenericApp, Loader, type GenericAppProps, type GenericAppState } from '@iobroker/gui-components';
import { AdminApi } from '../../src/shared/AdminApi';
import AdminPanel from './AdminPanel';

export default class App extends GenericApp<GenericAppProps, GenericAppState> {
    private readonly api: AdminApi;

    public constructor(props: GenericAppProps) {
        super(props, {
            ...props,
            adapterName: 'smart-text2command',
            socket: window.location.port === '3000' ? { port: 8081 } : undefined,
            doNotLoadAllObjects: true,
        });
        this.api = new AdminApi((command, message) => this.socket.sendTo(this.instanceId, command, message));
    }

    public render(): React.JSX.Element {
        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    {this.state.loaded ? (
                        <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', color: 'text.primary' }}>
                            <AdminPanel
                                api={this.api}
                                defaultLanguage={this.state.native.defaultLanguage === 'en' ? 'en' : 'de'}
                                onDefaultLanguage={value => this.updateNativeValue('defaultLanguage', value)}
                            />
                            {this.renderHelperDialogs()}
                        </Box>
                    ) : (
                        <Loader themeType={this.state.themeType} />
                    )}
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}
