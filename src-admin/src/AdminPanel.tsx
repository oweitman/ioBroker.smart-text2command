import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    FormControlLabel,
    MenuItem,
    Pagination,
    Select,
    Snackbar,
    Stack,
    Switch,
    Tab,
    Tabs,
    TextField,
    Typography,
} from '@mui/material';
import type { AdminApi } from '../../src/shared/AdminApi';
import { parseAliases, validateApproval, validateIntentDraft } from '../../src/shared/AdminForms';
import type { DeviceRecord, Capability, ActionKind } from '../../src/devices/types';
import type { IntentDefinition } from '../../src/nlp/types';
import type { CommandResult } from '../../src/commands/types';

type Language = 'de' | 'en';
type Page = 'dashboard' | 'devices' | 'intents' | 'training' | 'test' | 'settings';
type Diagnostics = {
    modelStatus?: string;
    modelVersion?: string;
    deviceCount?: number;
    approvedDevices?: number;
    lastError?: string;
};
type Training = {
    status: string;
    id?: string;
    modelVersion?: string;
    version?: string;
    regressionPassed?: number;
    regressionTotal?: number;
    error?: string;
};
type DeviceList = { total: number; devices: DeviceRecord[]; rooms?: string[] };

const pages: Array<{ id: Page; de: string; en: string }> = [
    { id: 'dashboard', de: 'Übersicht', en: 'Overview' },
    { id: 'devices', de: 'Geräte', en: 'Devices' },
    { id: 'intents', de: 'Intents', en: 'Intents' },
    { id: 'training', de: 'Training', en: 'Training' },
    { id: 'test', de: 'Testlabor', en: 'Test lab' },
    { id: 'settings', de: 'Einstellungen', en: 'Settings' },
];
const actions: Record<Capability['kind'], ActionKind[]> = {
    onOff: ['turnOn', 'turnOff', 'getState'],
    brightness: ['setLevel', 'getValue'],
    temperatureSetpoint: ['setTemperature', 'getValue'],
    readTemperature: ['getValue'],
    position: [],
};
const operationOptions: ActionKind[] = ['turnOn', 'turnOff', 'setLevel', 'setTemperature', 'getState', 'getValue'];

interface Props {
    api: AdminApi;
    defaultLanguage: Language;
    onDefaultLanguage: (value: Language) => void;
}

function labels(language: Language): (de: string, en: string) => string {
    return (de, en) => (language === 'de' ? de : en);
}

function displayError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function approvalKey(action: ActionKind, capability: Capability): string {
    return `${action}:${capability.stateId}`;
}

function DeviceCard({
    device,
    language,
    update,
    onError,
}: {
    device: DeviceRecord;
    language: Language;
    update: (payload: Record<string, unknown>) => Promise<void>;
    onError: (message: string) => void;
}): React.JSX.Element {
    const t = labels(language);
    const [aliasDe, setAliasDe] = useState((device.aliases.de ?? []).join(', '));
    const [aliasEn, setAliasEn] = useState((device.aliases.en ?? []).join(', '));
    const [pending, setPending] = useState<{ capability: Capability; action: ActionKind }>();
    useEffect(() => {
        setAliasDe((device.aliases.de ?? []).join(', '));
        setAliasEn((device.aliases.en ?? []).join(', '));
    }, [device.aliases]);
    const saveAliases = (): void => {
        try {
            void update({ deviceId: device.id, aliases: { de: parseAliases(aliasDe), en: parseAliases(aliasEn) } });
        } catch (error) {
            onError(displayError(error));
        }
    };
    const approve = (): void => {
        if (!pending) return;
        try {
            validateApproval(device, pending.capability.stateId, pending.action);
            void update({
                deviceId: device.id,
                approval: { stateId: pending.capability.stateId, action: pending.action, approved: true },
            });
            setPending(undefined);
        } catch (error) {
            onError(displayError(error));
        }
    };
    return (
        <Card
            variant="outlined"
            sx={{ mb: 2 }}
        >
            <CardContent>
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}
                >
                    <Box>
                        <Typography variant="h6">{device.displayName}</Typography>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {device.id}
                        </Typography>
                    </Box>
                    <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                    >
                        <Chip
                            size="small"
                            label={device.status}
                            color={
                                device.status === 'needsReview'
                                    ? 'warning'
                                    : device.status === 'missing'
                                      ? 'error'
                                      : 'default'
                            }
                        />
                        <FormControlLabel
                            label={t('Aktiv', 'Enabled')}
                            control={
                                <Switch
                                    checked={device.enabled}
                                    onChange={event =>
                                        void update({ deviceId: device.id, enabled: event.target.checked })
                                    }
                                />
                            }
                        />
                    </Stack>
                </Stack>
                <Typography
                    variant="body2"
                    sx={{ mt: 1 }}
                >
                    {t('Räume', 'Rooms')}: {device.roomIds.join(', ') || '—'}
                </Typography>
                {device.status === 'needsReview' && (
                    <Alert
                        severity="warning"
                        sx={{ mt: 1 }}
                    >
                        {t(
                            'Eine Capability hat sich geändert. Prüfe das Mapping vor erneuter Freigabe.',
                            'A capability changed. Review the mapping before approving again.',
                        )}
                    </Alert>
                )}
                <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1}
                    sx={{ mt: 2, alignItems: { md: 'center' } }}
                >
                    <TextField
                        size="small"
                        fullWidth
                        label={t('Aliase Deutsch', 'German aliases')}
                        value={aliasDe}
                        onChange={event => setAliasDe(event.target.value)}
                    />
                    <TextField
                        size="small"
                        fullWidth
                        label={t('Aliase Englisch', 'English aliases')}
                        value={aliasEn}
                        onChange={event => setAliasEn(event.target.value)}
                    />
                    <Button
                        variant="outlined"
                        onClick={saveAliases}
                    >
                        {t('Aliase speichern', 'Save aliases')}
                    </Button>
                </Stack>
                <Divider sx={{ my: 2 }} />
                {device.discoveredCapabilities.map(capability => (
                    <Box
                        key={capability.stateId}
                        sx={{ mb: 2 }}
                    >
                        <Stack
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                        >
                            <Typography variant="subtitle2">{capability.kind}</Typography>
                            {capability.needsReview && (
                                <Chip
                                    size="small"
                                    color="warning"
                                    label={t('Prüfung nötig', 'Review needed')}
                                />
                            )}
                        </Stack>
                        <Typography
                            variant="body2"
                            sx={{ wordBreak: 'break-all' }}
                        >
                            {capability.stateId}
                        </Typography>
                        <Typography
                            variant="caption"
                            color="text.secondary"
                        >
                            {capability.valueKind} · {capability.readable ? 'read' : ''}
                            {capability.writable ? ' / write' : ''}
                            {capability.min !== undefined ? ` · min ${capability.min}` : ''}
                            {capability.max !== undefined ? ` · max ${capability.max}` : ''}
                            {capability.unit ? ` · ${capability.unit}` : ''}
                            {capability.mapping ? ` · ${JSON.stringify(capability.mapping)}` : ''}
                        </Typography>
                        <Stack
                            direction="row"
                            spacing={1}
                            sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}
                        >
                            {actions[capability.kind]
                                .filter(action =>
                                    action.startsWith('get') ? capability.readable : capability.writable,
                                )
                                .map(action => {
                                    const approved =
                                        device.approvedCapabilities[approvalKey(action, capability)] ===
                                            capability.fingerprint && !capability.needsReview;
                                    return (
                                        <Button
                                            key={action}
                                            size="small"
                                            variant={approved ? 'contained' : 'outlined'}
                                            color={approved ? 'success' : 'primary'}
                                            disabled={device.status === 'missing'}
                                            onClick={() =>
                                                approved
                                                    ? void update({
                                                          deviceId: device.id,
                                                          approval: {
                                                              stateId: capability.stateId,
                                                              action,
                                                              approved: false,
                                                          },
                                                      })
                                                    : setPending({ capability, action })
                                            }
                                        >
                                            {action}:{' '}
                                            {approved ? t('freigegeben', 'approved') : t('freigeben', 'approve')}
                                        </Button>
                                    );
                                })}
                        </Stack>
                    </Box>
                ))}
                <Dialog
                    open={!!pending}
                    onClose={() => setPending(undefined)}
                    maxWidth="sm"
                    fullWidth
                >
                    <DialogTitle>{t('Aktion freigeben', 'Approve action')}</DialogTitle>
                    <DialogContent>
                        <Typography>
                            {pending?.action} · {device.displayName}
                        </Typography>
                        <Typography sx={{ wordBreak: 'break-all' }}>{pending?.capability.stateId}</Typography>
                        <Typography
                            variant="body2"
                            sx={{ mt: 1 }}
                        >
                            {t('Typ, Bereich und Mapping:', 'Type, range and mapping:')} {pending?.capability.valueKind}
                            , {pending?.capability.min ?? '—'}–{pending?.capability.max ?? '—'},{' '}
                            {JSON.stringify(pending?.capability.mapping ?? {})}
                        </Typography>
                        <Alert
                            severity="warning"
                            sx={{ mt: 2 }}
                        >
                            {t(
                                'Diese Freigabe gilt künftig für passende Befehle, bis das Ziel geändert oder die Freigabe widerrufen wird.',
                                'This approval applies to matching commands until the target changes or approval is revoked.',
                            )}
                        </Alert>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setPending(undefined)}>{t('Abbrechen', 'Cancel')}</Button>
                        <Button
                            variant="contained"
                            onClick={approve}
                        >
                            {t('Freigeben', 'Approve')}
                        </Button>
                    </DialogActions>
                </Dialog>
            </CardContent>
        </Card>
    );
}

export default function AdminPanel({ api, defaultLanguage, onDefaultLanguage }: Props): React.JSX.Element {
    const t = labels(defaultLanguage);
    const [page, setPage] = useState<Page>('dashboard');
    const [diagnostics, setDiagnostics] = useState<Diagnostics>({});
    const [training, setTraining] = useState<Training>({ status: 'idle' });
    const [deviceList, setDeviceList] = useState<DeviceList>({ total: 0, devices: [] });
    const [intents, setIntents] = useState<IntentDefinition[]>([]);
    const [filter, setFilter] = useState('');
    const [room, setRoom] = useState('');
    const [capability, setCapability] = useState('');
    const [devicePage, setDevicePage] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [importDraft, setImportDraft] = useState<{ schemaVersion: number; intents: IntentDefinition[] }>();

    const refresh = useCallback(
        async (offset = 0): Promise<void> => {
            const [devices, status, model, listed] = await Promise.all([
                api.call<DeviceList>('listDevices', { offset, limit: 50, filter, room, capability }),
                api.call<Diagnostics>('getDiagnostics'),
                api.call<Training>('getTrainingStatus'),
                api.call<{ intents: IntentDefinition[] }>('listIntents'),
            ]);
            setDeviceList(devices);
            setDiagnostics(status);
            setTraining(model);
            setIntents(listed.intents);
        },
        [api, filter, room, capability],
    );

    useEffect(() => {
        void refresh((devicePage - 1) * 50).catch(error => setError(displayError(error)));
    }, [refresh, devicePage]);
    useEffect(() => {
        if (training.status !== 'running') return;
        const timer = window.setInterval(
            () =>
                void api
                    .call<Training>('getTrainingStatus')
                    .then(setTraining)
                    .catch(error => setError(displayError(error))),
            2500,
        );
        return () => window.clearInterval(timer);
    }, [api, training.status]);

    async function mutate(command: string, payload: Record<string, unknown>, message?: string): Promise<void> {
        setBusy(true);
        try {
            await api.call(command, payload);
            await refresh((devicePage - 1) * 50);
            if (message) setNotice(message);
        } catch (error) {
            setError(displayError(error));
        } finally {
            setBusy(false);
        }
    }

    async function exportIntents(): Promise<void> {
        try {
            const data = await api.call<{ schemaVersion: number; intents: IntentDefinition[] }>('exportIntents');
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'smart-text2command-intents.json';
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            setError(displayError(error));
        }
    }

    async function readImport(file: File | undefined): Promise<void> {
        if (!file) return;
        try {
            if (file.size > 65_536) throw new Error('Import exceeds 64 KiB');
            const data: unknown = JSON.parse(await file.text());
            if (
                !data ||
                typeof data !== 'object' ||
                !('schemaVersion' in data) ||
                data.schemaVersion !== 1 ||
                !('intents' in data) ||
                !Array.isArray(data.intents)
            )
                throw new Error('Invalid intent import');
            for (const intent of data.intents) validateIntentDraft(intent as IntentDefinition);
            setImportDraft(data as { schemaVersion: number; intents: IntentDefinition[] });
        } catch (error) {
            setError(displayError(error));
        }
    }

    const roomOptions = useMemo(() => deviceList.rooms ?? [], [deviceList.rooms]);

    return (
        <Box sx={{ maxWidth: 1200, mx: 'auto', p: { xs: 2, md: 3 } }}>
            <Stack
                direction="row"
                spacing={2}
                sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
            >
                <Box>
                    <Typography variant="h4">smart-text2command</Typography>
                    <Typography color="text.secondary">
                        {t(
                            'Lokale Textsteuerung mit geprüften Geräteaktionen',
                            'Local text control with approved device actions',
                        )}
                    </Typography>
                </Box>
                {busy && <CircularProgress size={24} />}
            </Stack>
            <Tabs
                value={page}
                onChange={(_event, value: Page) => setPage(value)}
                variant="scrollable"
                scrollButtons="auto"
                sx={{ mb: 3 }}
            >
                {pages.map(item => (
                    <Tab
                        key={item.id}
                        value={item.id}
                        label={defaultLanguage === 'de' ? item.de : item.en}
                    />
                ))}
            </Tabs>
            {page === 'dashboard' && (
                <Stack spacing={2}>
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={2}
                    >
                        <Card sx={{ flex: 1 }}>
                            <CardContent>
                                <Typography color="text.secondary">{t('Modell', 'Model')}</Typography>
                                <Typography variant="h5">{diagnostics.modelStatus ?? '—'}</Typography>
                                <Typography variant="caption">{diagnostics.modelVersion ?? '—'}</Typography>
                            </CardContent>
                        </Card>
                        <Card sx={{ flex: 1 }}>
                            <CardContent>
                                <Typography color="text.secondary">
                                    {t('Erkannte Geräte', 'Discovered devices')}
                                </Typography>
                                <Typography variant="h5">{diagnostics.deviceCount ?? '—'}</Typography>
                            </CardContent>
                        </Card>
                        <Card sx={{ flex: 1 }}>
                            <CardContent>
                                <Typography color="text.secondary">
                                    {t('Freigegebene Geräte', 'Approved devices')}
                                </Typography>
                                <Typography variant="h5">{diagnostics.approvedDevices ?? '—'}</Typography>
                            </CardContent>
                        </Card>
                    </Stack>
                    {diagnostics.lastError && <Alert severity="error">{diagnostics.lastError}</Alert>}
                    <Button
                        sx={{ alignSelf: 'start' }}
                        onClick={() =>
                            void refresh((devicePage - 1) * 50).catch(error => setError(displayError(error)))
                        }
                    >
                        {t('Aktualisieren', 'Refresh')}
                    </Button>
                </Stack>
            )}
            {page === 'devices' && (
                <Box>
                    <Stack
                        direction={{ xs: 'column', md: 'row' }}
                        spacing={1}
                        sx={{ mb: 2 }}
                    >
                        <TextField
                            size="small"
                            label={t('Gerät suchen', 'Search devices')}
                            value={filter}
                            onChange={event => {
                                setFilter(event.target.value);
                                setDevicePage(1);
                            }}
                        />
                        <TextField
                            size="small"
                            select
                            label={t('Raum', 'Room')}
                            value={room}
                            onChange={event => {
                                setRoom(event.target.value);
                                setDevicePage(1);
                            }}
                            sx={{ minWidth: 160 }}
                        >
                            <MenuItem value="">{t('Alle Räume', 'All rooms')}</MenuItem>
                            {roomOptions.map(item => (
                                <MenuItem
                                    key={item}
                                    value={item}
                                >
                                    {item}
                                </MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            size="small"
                            select
                            label="Capability"
                            value={capability}
                            onChange={event => {
                                setCapability(event.target.value);
                                setDevicePage(1);
                            }}
                            sx={{ minWidth: 170 }}
                        >
                            <MenuItem value="">{t('Alle', 'All')}</MenuItem>
                            {Object.keys(actions).map(item => (
                                <MenuItem
                                    key={item}
                                    value={item}
                                >
                                    {item}
                                </MenuItem>
                            ))}
                        </TextField>
                    </Stack>
                    <Typography sx={{ mb: 2 }}>
                        {deviceList.total} {t('Geräte', 'devices')}
                    </Typography>
                    {deviceList.devices.map(device => (
                        <DeviceCard
                            key={device.id}
                            device={device}
                            language={defaultLanguage}
                            onError={setError}
                            update={payload => mutate('updateDevice', payload, t('Gerät gespeichert', 'Device saved'))}
                        />
                    ))}
                    {deviceList.total > 50 && (
                        <Pagination
                            count={Math.ceil(deviceList.total / 50)}
                            page={devicePage}
                            onChange={(_event, value) => setDevicePage(value)}
                        />
                    )}
                </Box>
            )}
            {page === 'intents' && (
                <IntentEditor
                    intents={intents}
                    language={defaultLanguage}
                    onSave={intent =>
                        mutate(
                            'saveIntent',
                            { intent },
                            t(
                                'Intent gespeichert. Für die Aktivierung Modell trainieren.',
                                'Intent saved. Train the model to activate it.',
                            ),
                        )
                    }
                    onDelete={id =>
                        mutate(
                            'deleteIntent',
                            { id },
                            t('Intent gelöscht. Modell neu trainieren.', 'Intent deleted. Retrain the model.'),
                        )
                    }
                />
            )}
            {page === 'training' && (
                <TrainingPage
                    training={training}
                    language={defaultLanguage}
                    busy={busy}
                    onTrain={() => mutate('trainModel', {}, t('Training gestartet', 'Training started'))}
                    onRollback={() => mutate('rollbackModel', {}, t('Modell zurückgesetzt', 'Model rolled back'))}
                />
            )}
            {page === 'test' && (
                <TestLab
                    api={api}
                    language={defaultLanguage}
                />
            )}
            {page === 'settings' && (
                <Stack spacing={2}>
                    <TextField
                        select
                        label={t('Standardsprache', 'Default language')}
                        value={defaultLanguage}
                        onChange={event => onDefaultLanguage(event.target.value as Language)}
                        sx={{ maxWidth: 240 }}
                    >
                        <MenuItem value="de">Deutsch</MenuItem>
                        <MenuItem value="en">English</MenuItem>
                    </TextField>
                    <Typography variant="body2">
                        {t(
                            'Die Sprache wird mit dem Speichern der Adapterkonfiguration übernommen.',
                            'The language takes effect after saving adapter configuration.',
                        )}
                    </Typography>
                    <Typography variant="h6">{t('Diagnose', 'Diagnostics')}</Typography>
                    <Box
                        component="pre"
                        sx={{ p: 2, bgcolor: 'action.hover', overflowX: 'auto' }}
                    >
                        {JSON.stringify({ ...diagnostics, training }, null, 2)}
                    </Box>
                    <Button
                        sx={{ alignSelf: 'start' }}
                        onClick={() =>
                            void refresh((devicePage - 1) * 50).catch(error => setError(displayError(error)))
                        }
                    >
                        {t('Diagnose aktualisieren', 'Refresh diagnostics')}
                    </Button>
                    <Divider />
                    <Typography variant="h6">
                        {t('Eigene Intents exportieren/importieren', 'Export/import custom intents')}
                    </Typography>
                    <Typography variant="body2">
                        {t(
                            'Freigaben und Geräte werden dabei nicht importiert. Nach dem Import muss das Modell neu trainiert werden.',
                            'Device approvals are not imported. Train the model after importing.',
                        )}
                    </Typography>
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        sx={{ alignItems: { sm: 'center' } }}
                    >
                        <Button
                            variant="outlined"
                            onClick={() => void exportIntents()}
                        >
                            {t('Exportieren', 'Export')}
                        </Button>
                        <Button
                            variant="outlined"
                            component="label"
                        >
                            {t('JSON-Datei wählen', 'Choose JSON file')}
                            <input
                                hidden
                                type="file"
                                accept="application/json,.json"
                                onChange={event => void readImport(event.target.files?.[0])}
                            />
                        </Button>
                    </Stack>
                </Stack>
            )}
            <Dialog
                open={!!importDraft}
                onClose={() => setImportDraft(undefined)}
            >
                <DialogTitle>{t('Trainingsdaten ersetzen?', 'Replace training data?')}</DialogTitle>
                <DialogContent>
                    {t('Eigene Intents in Datei', 'Custom intents in file')}: {importDraft?.intents.length}.{' '}
                    {t(
                        'Das aktive Modell bleibt bis zum nächsten Training unverändert.',
                        'The active model stays unchanged until training.',
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setImportDraft(undefined)}>{t('Abbrechen', 'Cancel')}</Button>
                    <Button
                        color="warning"
                        onClick={() => {
                            if (!importDraft) return;
                            void mutate('importIntents', importDraft, t('Intents importiert', 'Intents imported'));
                            setImportDraft(undefined);
                        }}
                    >
                        {t('Ersetzen', 'Replace')}
                    </Button>
                </DialogActions>
            </Dialog>
            <Snackbar
                open={!!error}
                autoHideDuration={8000}
                onClose={() => setError('')}
            >
                <Alert
                    severity="error"
                    onClose={() => setError('')}
                >
                    {error}
                </Alert>
            </Snackbar>
            <Snackbar
                open={!!notice}
                autoHideDuration={5000}
                onClose={() => setNotice('')}
            >
                <Alert
                    severity="success"
                    onClose={() => setNotice('')}
                >
                    {notice}
                </Alert>
            </Snackbar>
        </Box>
    );
}

const emptyIntent = (): IntentDefinition => ({
    id: '',
    source: 'user',
    enabled: true,
    utterances: { de: [], en: [] },
    action: { kind: 'capability', operation: 'turnOn' },
});

function IntentEditor({
    intents,
    language,
    onSave,
    onDelete,
}: {
    intents: IntentDefinition[];
    language: Language;
    onSave: (intent: IntentDefinition) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
}): React.JSX.Element {
    const t = labels(language);
    const [draft, setDraft] = useState<IntentDefinition>(emptyIntent);
    const [editingId, setEditingId] = useState<string>();
    const [error, setError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const action = draft.action ?? { kind: 'capability' as const, operation: 'turnOn' as const };
    const edit = (intent: IntentDefinition, existing = true): void => {
        setDraft(structuredClone(intent));
        setEditingId(existing ? intent.id : undefined);
        setError('');
    };
    const save = async (): Promise<void> => {
        try {
            validateIntentDraft(draft);
            if (!editingId && intents.some(item => item.id === draft.id)) {
                throw new Error('Intent ID already exists');
            }
            await onSave(draft);
            setEditingId(draft.id);
            setError('');
        } catch (error) {
            setError(displayError(error));
        }
    };
    return (
        <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
        >
            <Box sx={{ minWidth: { md: 250 }, flex: 1 }}>
                <Button
                    variant="outlined"
                    onClick={() => edit(emptyIntent(), false)}
                    sx={{ mb: 2 }}
                >
                    {t('Neuer Intent', 'New intent')}
                </Button>
                <Typography variant="subtitle1">{t('System-Intents', 'System intents')}</Typography>
                {intents
                    .filter(item => item.source === 'system')
                    .map(item => (
                        <Typography
                            key={item.id}
                            variant="body2"
                            sx={{ py: 0.5 }}
                        >
                            {item.id} · {(item.utterances[language] ?? []).length} {t('Beispiele', 'examples')}
                        </Typography>
                    ))}
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle1">{t('Eigene Intents', 'Custom intents')}</Typography>
                {intents
                    .filter(item => item.source === 'user')
                    .map(item => (
                        <Button
                            key={item.id}
                            sx={{ display: 'block' }}
                            onClick={() => edit(item)}
                        >
                            {item.id}
                        </Button>
                    ))}
            </Box>
            <Card
                variant="outlined"
                sx={{ flex: 2 }}
            >
                <CardContent>
                    <Stack spacing={2}>
                        <Typography variant="h6">{t('Intent bearbeiten', 'Edit intent')}</Typography>
                        <TextField
                            label="ID"
                            value={draft.id}
                            disabled={intents.some(item => item.source === 'user' && item.id === draft.id)}
                            onChange={event => setDraft({ ...draft, id: event.target.value })}
                            helperText={t('Eindeutige ID, z. B. meinLicht', 'Unique ID, e.g. myLight')}
                        />
                        <FormControlLabel
                            label={t('Aktiv', 'Enabled')}
                            control={
                                <Switch
                                    checked={draft.enabled}
                                    onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
                                />
                            }
                        />
                        <TextField
                            multiline
                            minRows={4}
                            label={t(
                                'Deutsche Trainingsbeispiele (eine Zeile pro Beispiel)',
                                'German training examples (one per line)',
                            )}
                            value={(draft.utterances.de ?? []).join('\n')}
                            onChange={event =>
                                setDraft({
                                    ...draft,
                                    utterances: { ...draft.utterances, de: event.target.value.split('\n') },
                                })
                            }
                        />
                        <TextField
                            multiline
                            minRows={4}
                            label={t(
                                'Englische Trainingsbeispiele (eine Zeile pro Beispiel)',
                                'English training examples (one per line)',
                            )}
                            value={(draft.utterances.en ?? []).join('\n')}
                            onChange={event =>
                                setDraft({
                                    ...draft,
                                    utterances: { ...draft.utterances, en: event.target.value.split('\n') },
                                })
                            }
                        />
                        <TextField
                            select
                            label={t('Aktionstyp', 'Action type')}
                            value={action.kind}
                            onChange={event =>
                                setDraft({
                                    ...draft,
                                    action:
                                        event.target.value === 'response'
                                            ? { kind: 'response', response: { de: '', en: '' } }
                                            : { kind: 'capability', operation: 'turnOn' },
                                })
                            }
                        >
                            <MenuItem value="capability">{t('Geräteaktion', 'Device action')}</MenuItem>
                            <MenuItem value="response">{t('Antwortvorlage', 'Response template')}</MenuItem>
                        </TextField>
                        {action.kind === 'capability' ? (
                            <TextField
                                select
                                label={t('Operation', 'Operation')}
                                value={action.operation}
                                onChange={event =>
                                    setDraft({
                                        ...draft,
                                        action: { kind: 'capability', operation: event.target.value as ActionKind },
                                    })
                                }
                            >
                                {operationOptions.map(item => (
                                    <MenuItem
                                        value={item}
                                        key={item}
                                    >
                                        {item}
                                    </MenuItem>
                                ))}
                            </TextField>
                        ) : (
                            <>
                                <TextField
                                    label={t('Antwort Deutsch', 'German response')}
                                    value={action.response.de ?? ''}
                                    onChange={event =>
                                        setDraft({
                                            ...draft,
                                            action: {
                                                kind: 'response',
                                                response: { ...action.response, de: event.target.value },
                                            },
                                        })
                                    }
                                />
                                <TextField
                                    label={t('Antwort Englisch', 'English response')}
                                    value={action.response.en ?? ''}
                                    onChange={event =>
                                        setDraft({
                                            ...draft,
                                            action: {
                                                kind: 'response',
                                                response: { ...action.response, en: event.target.value },
                                            },
                                        })
                                    }
                                />
                            </>
                        )}
                        {error && <Alert severity="error">{error}</Alert>}
                        <Alert severity="info">
                            {t(
                                'Speichern ändert die Trainingsdaten. Das aktive Modell bleibt bis zum nächsten erfolgreichen Training bestehen.',
                                'Saving changes training data. The active model stays in place until training succeeds.',
                            )}
                        </Alert>
                        <Stack
                            direction="row"
                            spacing={1}
                        >
                            <Button
                                variant="contained"
                                onClick={() => void save()}
                            >
                                {t('Speichern', 'Save')}
                            </Button>
                            {intents.some(item => item.source === 'user' && item.id === draft.id) && (
                                <Button
                                    color="error"
                                    onClick={() => setConfirmDelete(true)}
                                >
                                    {t('Löschen', 'Delete')}
                                </Button>
                            )}
                        </Stack>
                    </Stack>
                </CardContent>
            </Card>
            <Dialog
                open={confirmDelete}
                onClose={() => setConfirmDelete(false)}
            >
                <DialogTitle>{t('Intent löschen?', 'Delete intent?')}</DialogTitle>
                <DialogContent>{draft.id}</DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmDelete(false)}>{t('Abbrechen', 'Cancel')}</Button>
                    <Button
                        color="error"
                        onClick={() => {
                            void onDelete(draft.id);
                            setConfirmDelete(false);
                            edit(emptyIntent(), false);
                        }}
                    >
                        {t('Löschen', 'Delete')}
                    </Button>
                </DialogActions>
            </Dialog>
        </Stack>
    );
}

function TrainingPage({
    training,
    language,
    busy,
    onTrain,
    onRollback,
}: {
    training: Training;
    language: Language;
    busy: boolean;
    onTrain: () => Promise<void>;
    onRollback: () => Promise<void>;
}): React.JSX.Element {
    const t = labels(language);
    const [confirmRollback, setConfirmRollback] = useState(false);
    return (
        <Card variant="outlined">
            <CardContent>
                <Stack spacing={2}>
                    <Typography variant="h6">{t('Modelltraining', 'Model training')}</Typography>
                    <Typography>
                        {t('Status', 'Status')}: {training.status}
                    </Typography>
                    <Typography>
                        {t('Modellversion', 'Model version')}: {training.version ?? training.modelVersion ?? '—'}
                    </Typography>
                    <Typography>
                        {t('Regression', 'Regression')}: {training.regressionPassed ?? '—'} /{' '}
                        {training.regressionTotal ?? '—'}
                    </Typography>
                    {training.error && <Alert severity="error">{training.error}</Alert>}
                    {training.status === 'running' && <LinearProgressFallback />}
                    <Stack
                        direction="row"
                        spacing={1}
                    >
                        <Button
                            variant="contained"
                            disabled={busy || training.status === 'running'}
                            onClick={() => void onTrain()}
                        >
                            {t('Training starten', 'Start training')}
                        </Button>
                        <Button
                            variant="outlined"
                            disabled={busy || training.status === 'running'}
                            onClick={() => setConfirmRollback(true)}
                        >
                            {t('Vorheriges Modell aktivieren', 'Activate previous model')}
                        </Button>
                    </Stack>
                    <Alert severity="info">
                        {t(
                            'Training läuft im Hintergrund. Das aktive Modell wechselt nur nach erfolgreicher Regression.',
                            'Training runs in the background. The active model changes only after regression succeeds.',
                        )}
                    </Alert>
                    <Dialog
                        open={confirmRollback}
                        onClose={() => setConfirmRollback(false)}
                    >
                        <DialogTitle>{t('Modell zurücksetzen?', 'Roll back model?')}</DialogTitle>
                        <DialogActions>
                            <Button onClick={() => setConfirmRollback(false)}>{t('Abbrechen', 'Cancel')}</Button>
                            <Button
                                onClick={() => {
                                    void onRollback();
                                    setConfirmRollback(false);
                                }}
                            >
                                {t('Zurücksetzen', 'Roll back')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                </Stack>
            </CardContent>
        </Card>
    );
}

function LinearProgressFallback(): React.JSX.Element {
    return (
        <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center' }}
        >
            <CircularProgress size={18} />
            <Typography variant="body2">Training …</Typography>
        </Stack>
    );
}

function TestLab({ api, language }: { api: AdminApi; language: Language }): React.JSX.Element {
    const t = labels(language);
    const [text, setText] = useState('');
    const [selectedLanguage, setSelectedLanguage] = useState<Language>(language);
    const [mode, setMode] = useState<'analyze' | 'execute'>('analyze');
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<CommandResult>();
    const [sessionId] = useState(() => crypto.randomUUID());

    async function submit(selection?: string): Promise<void> {
        setBusy(true);
        setError('');
        try {
            if (!selection && (!text.trim() || text.length > 1000)) throw new Error('Enter up to 1000 characters');
            const response = await api.call<CommandResult>('processText', {
                requestId: crypto.randomUUID(),
                sessionId,
                text: text.trim(),
                language: selectedLanguage,
                mode,
                ...(selection && result?.clarification ? { clarificationId: result.clarification.id, selection } : {}),
            });
            setResult(response);
        } catch (error) {
            setError(displayError(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card variant="outlined">
            <CardContent>
                <Stack spacing={2}>
                    <Typography variant="h6">{t('Testlabor', 'Test lab')}</Typography>
                    <TextField
                        label={t('Befehl', 'Command')}
                        multiline
                        minRows={2}
                        value={text}
                        onChange={event => setText(event.target.value)}
                        slotProps={{ htmlInput: { maxLength: 1000 } }}
                    />
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={2}
                        sx={{ alignItems: { sm: 'center' } }}
                    >
                        <TextField
                            select
                            size="small"
                            label={t('Sprache', 'Language')}
                            value={selectedLanguage}
                            onChange={event => setSelectedLanguage(event.target.value as Language)}
                            sx={{ minWidth: 140 }}
                        >
                            <MenuItem value="de">Deutsch</MenuItem>
                            <MenuItem value="en">English</MenuItem>
                        </TextField>
                        <FormControlLabel
                            label={t('Ausführen', 'Execute')}
                            control={
                                <Switch
                                    checked={mode === 'execute'}
                                    onChange={event => setMode(event.target.checked ? 'execute' : 'analyze')}
                                />
                            }
                        />
                        <Button
                            variant="contained"
                            disabled={busy || !text.trim()}
                            onClick={() => (mode === 'execute' ? setConfirm(true) : void submit())}
                        >
                            {mode === 'execute'
                                ? t('Ausführung prüfen', 'Review execution')
                                : t('Analysieren', 'Analyze')}
                        </Button>
                    </Stack>
                    {mode === 'execute' && (
                        <Alert severity="warning">
                            {t(
                                'Ausführung verwendet nur bereits freigegebene Aktionen.',
                                'Execution uses only approved actions.',
                            )}
                        </Alert>
                    )}
                    {busy && <CircularProgress size={24} />}
                    {error && <Alert severity="error">{error}</Alert>}
                    {result && (
                        <Box>
                            <Alert
                                severity={
                                    result.status === 'success'
                                        ? 'success'
                                        : result.status === 'clarification'
                                          ? 'info'
                                          : 'warning'
                                }
                            >
                                {result.response} {result.errorCode ? `(${result.errorCode})` : ''}
                            </Alert>
                            <Stack
                                direction="row"
                                spacing={1}
                                sx={{ mt: 2, flexWrap: 'wrap' }}
                            >
                                <Chip label={`${t('Intent', 'Intent')}: ${result.intent ?? '—'}`} />
                                <Chip
                                    label={`${t('Konfidenz', 'Confidence')}: ${result.confidence?.toFixed(3) ?? '—'}`}
                                />
                                <Chip label={`${t('Modell', 'Model')}: ${result.modelVersion ?? '—'}`} />
                            </Stack>
                            {result.candidates?.length ? (
                                <Typography sx={{ mt: 2 }}>
                                    {t('Gerätekandidaten', 'Device candidates')}:{' '}
                                    {result.candidates
                                        .map(item => `${item.deviceId} (${item.score.toFixed(2)})`)
                                        .join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.alternatives?.length ? (
                                <Typography sx={{ mt: 1 }}>
                                    {t('Intent-Ranking', 'Intent ranking')}:{' '}
                                    {result.analysis.alternatives
                                        .slice(0, 5)
                                        .map(item => `${item.intent} (${item.confidence.toFixed(2)})`)
                                        .join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.entities?.length ? (
                                <Typography sx={{ mt: 1 }}>
                                    {t('Entitäten', 'Entities')}:{' '}
                                    {result.analysis.entities.map(item => `${item.type}=${item.value}`).join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.plan && (
                                <Typography sx={{ mt: 1 }}>
                                    {t('Geplanter Zugriff', 'Planned access')}: {result.analysis.plan.operation}{' '}
                                    {result.analysis.plan.stateId}{' '}
                                    {result.analysis.plan.value !== undefined ? `= ${result.analysis.plan.value}` : ''}{' '}
                                    · {t('Policy', 'Policy')}: {result.analysis.policyDecision ?? '—'}
                                </Typography>
                            )}
                            {result.actions?.map(item => (
                                <Typography
                                    key={item.stateId}
                                    sx={{ mt: 1 }}
                                >
                                    {item.stateId}: {item.status}
                                    {item.value !== undefined ? ` = ${item.value}` : ''}
                                </Typography>
                            ))}
                            {result.clarification && (
                                <Stack
                                    direction="row"
                                    spacing={1}
                                    sx={{ mt: 2 }}
                                >
                                    {result.clarification.options?.map(item => (
                                        <Button
                                            variant="outlined"
                                            key={item.id}
                                            onClick={() => void submit(item.id)}
                                        >
                                            {item.label}
                                        </Button>
                                    ))}
                                    {result.clarification.key === 'value' && (
                                        <ValueAnswer onSubmit={value => void submit(value)} />
                                    )}
                                </Stack>
                            )}
                            <Box
                                component="pre"
                                sx={{ mt: 2, p: 2, bgcolor: 'action.hover', overflowX: 'auto' }}
                            >
                                {JSON.stringify(result, null, 2)}
                            </Box>
                        </Box>
                    )}
                    <Dialog
                        open={confirm}
                        onClose={() => setConfirm(false)}
                    >
                        <DialogTitle>{t('Befehl ausführen?', 'Execute command?')}</DialogTitle>
                        <DialogContent>{text}</DialogContent>
                        <DialogActions>
                            <Button onClick={() => setConfirm(false)}>{t('Abbrechen', 'Cancel')}</Button>
                            <Button
                                color="warning"
                                variant="contained"
                                onClick={() => {
                                    setConfirm(false);
                                    void submit();
                                }}
                            >
                                {t('Ausführen', 'Execute')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                </Stack>
            </CardContent>
        </Card>
    );
}

function ValueAnswer({ onSubmit }: { onSubmit: (value: string) => void }): React.JSX.Element {
    const [value, setValue] = useState('');
    return (
        <Stack
            direction="row"
            spacing={1}
        >
            <TextField
                size="small"
                label="Value"
                value={value}
                onChange={event => setValue(event.target.value)}
            />
            <Button
                disabled={!value.trim()}
                onClick={() => onSubmit(value.trim())}
            >
                OK
            </Button>
        </Stack>
    );
}
