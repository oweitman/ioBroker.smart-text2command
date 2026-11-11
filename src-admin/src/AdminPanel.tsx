import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
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
    IconButton,
    MenuItem,
    Pagination,
    Select,
    Snackbar,
    Stack,
    Switch,
    Tab,
    Tabs,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import AddCircleOutlinedIcon from '@mui/icons-material/AddCircleOutlined';
import CategoryIcon from '@mui/icons-material/Category';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeviceHubIcon from '@mui/icons-material/DeviceHub';
import LightModeIcon from '@mui/icons-material/LightMode';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import SensorsIcon from '@mui/icons-material/Sensors';
import ThermostatIcon from '@mui/icons-material/Thermostat';
import VisibilityIcon from '@mui/icons-material/Visibility';
import EditIcon from '@mui/icons-material/Edit';
import BlockIcon from '@mui/icons-material/Block';
import type { AdminApi } from '../../src/shared/AdminApi';
import { parseAliases, validateApproval, validateIntentDraft } from '../../src/shared/AdminForms';
import type { DeviceRecord, Capability, ActionKind } from '../../src/devices/types';
import type { IntentDefinition } from '../../src/nlp/types';
import type { CommandResult } from '../../src/commands/types';
import type { Language } from '../../src/types/api';
import LanguageValueTable, { languageOptions, rowsFromValues, valuesFromRows } from './LanguageValueTable';
import type { LanguageRow } from './LanguageValueTable';

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
type EnumOption = { id: string; name: string | Record<string, string> };
type DeviceList = { total: number; devices: DeviceRecord[]; rooms?: EnumOption[]; functions?: EnumOption[] };

const pages: Page[] = ['dashboard', 'devices', 'intents', 'training', 'test', 'settings'];
const localeFiles = import.meta.glob<Record<string, string>>('./i18n/*.json', { eager: true, import: 'default' });
const dictionaries: Record<Language, Record<string, string>> = Object.fromEntries(
    languageOptions.map(item => [item.code, localeFiles[`./i18n/${item.code}.json`] ?? {}]),
);
const actions: Record<Capability['kind'], ActionKind[]> = {
    onOff: ['turnOn', 'turnOff', 'getState'],
    brightness: ['setLevel', 'getValue'],
    temperatureSetpoint: ['setTemperature', 'getValue'],
    readTemperature: ['getValue'],
    position: [],
};
const operationOptions: ActionKind[] = ['turnOn', 'turnOff', 'setLevel', 'setTemperature', 'getState', 'getValue'];
function languageName(language: Language): string {
    return languageOptions.find(item => item.code === language)?.name ?? language;
}

function actionName(action: ActionKind, language: Language): string {
    return labels(language)(`action.${action}`);
}

function capabilityName(kind: Capability['kind'], language: Language): string {
    return labels(language)(`capability.${kind}`);
}

function capabilityIcon(kind: Capability['kind']): React.JSX.Element {
    switch (kind) {
        case 'onOff':
            return <PowerSettingsNewIcon fontSize="small" />;
        case 'brightness':
            return <LightModeIcon fontSize="small" />;
        case 'temperatureSetpoint':
            return <ThermostatIcon fontSize="small" />;
        case 'readTemperature':
            return <SensorsIcon fontSize="small" />;
        default:
            return <DeviceHubIcon fontSize="small" />;
    }
}

function isReadAction(action: ActionKind): boolean {
    return action === 'getState' || action === 'getValue';
}

function BulkActionIcon({ scope, revoke }: { scope: 'read' | 'write' | 'all'; revoke: boolean }): React.JSX.Element {
    return (
        <Box sx={{ display: 'inline-flex', position: 'relative', color: revoke ? 'text.secondary' : 'success.main' }}>
            {(scope === 'read' || scope === 'all') && <VisibilityIcon fontSize="small" />}
            {(scope === 'write' || scope === 'all') && <EditIcon fontSize="small" />}
            {revoke && (
                <BlockIcon sx={{ position: 'absolute', right: -5, bottom: -5, fontSize: 17, color: 'error.main' }} />
            )}
        </Box>
    );
}

interface Props {
    api: AdminApi;
    defaultLanguage: Language;
    onDefaultLanguage: (value: Language) => void;
}

function labels(language: Language): (key: string) => string {
    return key => dictionaries[language]?.[key] ?? dictionaries[languageOptions[0].code]?.[key] ?? key;
}

function displayError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function approvalKey(action: ActionKind, capability: Capability): string {
    return `${action}:${capability.stateId}`;
}

function enumLabel(name: string | Record<string, string> | undefined, id: string, language: Language): string {
    if (typeof name === 'string') return name;
    return name?.[language] ?? Object.values(name ?? {})[0] ?? id;
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
    const [aliasRows, setAliasRows] = useState<LanguageRow[]>(() =>
        rowsFromValues(
            Object.fromEntries(languageOptions.map(item => [item.code, (device.aliases[item.code] ?? []).join(', ')])),
            language,
        ),
    );
    const [pending, setPending] = useState<{ capability: Capability; action: ActionKind }>();
    const [batchScope, setBatchScope] = useState<'read' | 'write' | 'all'>();
    const [batchOperation, setBatchOperation] = useState<'grant' | 'revoke'>('grant');
    const [batchSelected, setBatchSelected] = useState<string[]>([]);
    const eligibleApprovals = device.discoveredCapabilities.flatMap(capability =>
        actions[capability.kind]
            .filter(action => (action.startsWith('get') ? capability.readable : capability.writable))
            .map(action => ({ capability, action, key: approvalKey(action, capability) })),
    );
    const availableApprovals = eligibleApprovals.filter(
        item => device.approvedCapabilities[item.key] !== item.capability.fingerprint || item.capability.needsReview,
    );
    const approvedActions = eligibleApprovals.filter(
        item => device.approvedCapabilities[item.key] === item.capability.fingerprint && !item.capability.needsReview,
    );
    const batchItems = (batchOperation === 'grant' ? availableApprovals : approvedActions).filter(item =>
        batchScope === 'all' ? true : batchScope === 'read' ? isReadAction(item.action) : !isReadAction(item.action),
    );
    const hasReadActions = eligibleApprovals.some(item => isReadAction(item.action));
    const hasWriteActions = eligibleApprovals.some(item => !isReadAction(item.action));
    const reviewCapabilities = device.discoveredCapabilities.filter(capability => capability.needsReview);
    useEffect(() => {
        setAliasRows(
            rowsFromValues(
                Object.fromEntries(
                    languageOptions.map(item => [item.code, (device.aliases[item.code] ?? []).join(', ')]),
                ),
                language,
            ),
        );
    }, [device.aliases, language]);
    const saveAliases = (): void => {
        try {
            const aliases: DeviceRecord['aliases'] = { ...device.aliases };
            const values = valuesFromRows(aliasRows);
            for (const item of languageOptions) {
                aliases[item.code] = parseAliases(values[item.code] ?? '');
            }
            void update({ deviceId: device.id, aliases });
        } catch (error) {
            onError(displayError(error));
        }
    };
    const countBatch = (scope: 'read' | 'write' | 'all', operation: 'grant' | 'revoke'): number =>
        (operation === 'grant' ? availableApprovals : approvedActions).filter(item =>
            scope === 'all' ? true : scope === 'read' ? isReadAction(item.action) : !isReadAction(item.action),
        ).length;
    const openBatch = (scope: 'read' | 'write' | 'all', operation: 'grant' | 'revoke'): void => {
        const selected = (operation === 'grant' ? availableApprovals : approvedActions).filter(item =>
            scope === 'all' ? true : scope === 'read' ? isReadAction(item.action) : !isReadAction(item.action),
        );
        setBatchScope(scope);
        setBatchOperation(operation);
        setBatchSelected(selected.map(item => item.key));
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
    const submitBatch = (): void => {
        try {
            const selected = batchItems.filter(item => batchSelected.includes(item.key));
            if (batchOperation === 'grant') {
                for (const item of selected) validateApproval(device, item.capability.stateId, item.action);
            }
            void update({
                deviceId: device.id,
                [batchOperation === 'grant' ? 'approvals' : 'revocations']: selected.map(item => ({
                    stateId: item.capability.stateId,
                    action: item.action,
                })),
            });
            setBatchScope(undefined);
            setBatchSelected([]);
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
                        <Stack
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: 'center' }}
                        >
                            {device.discoveredCapabilities[0] ? (
                                capabilityIcon(device.discoveredCapabilities[0].kind)
                            ) : (
                                <DeviceHubIcon fontSize="small" />
                            )}
                            <Typography
                                variant="h6"
                                sx={{ overflowWrap: 'anywhere' }}
                            >
                                {device.displayName} ({device.id})
                            </Typography>
                        </Stack>
                    </Box>
                    <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center' }}
                    >
                        <Chip
                            size="small"
                            label={
                                device.status === 'needsReview'
                                    ? t('ui.review_needed')
                                    : device.status === 'missing'
                                      ? t('ui.missing')
                                      : t('ui.available')
                            }
                            color={
                                device.status === 'needsReview'
                                    ? 'warning'
                                    : device.status === 'missing'
                                      ? 'error'
                                      : 'default'
                            }
                        />
                        <FormControlLabel
                            label={t('ui.enabled')}
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
                <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}
                >
                    {device.roomIds.map(id => (
                        <Chip
                            key={id}
                            size="small"
                            icon={<MeetingRoomIcon />}
                            label={enumLabel(device.enumNames?.[id], id, language)}
                        />
                    ))}
                    {device.functionIds.map(id => (
                        <Chip
                            key={id}
                            size="small"
                            icon={<CategoryIcon />}
                            label={enumLabel(device.enumNames?.[id], id, language)}
                        />
                    ))}
                </Stack>
                {!device.enabled && Object.keys(device.approvedCapabilities).length > 0 && (
                    <Alert
                        severity="info"
                        sx={{ mt: 1 }}
                    >
                        {t('ui.actions_are_approved_but_this_device_is_still_disabled_turn_on_e')}
                    </Alert>
                )}
                {reviewCapabilities.length > 0 && (
                    <Alert
                        severity="warning"
                        sx={{ mt: 1 }}
                    >
                        {t('ui.a_capability_changed_review_the_mapping_before_approving_again')}
                        <Box
                            component="ul"
                            sx={{ mt: 1, mb: 0, pl: 2.5 }}
                        >
                            {reviewCapabilities.map(capability => {
                                const affectedActions = Object.entries(device.approvedCapabilities)
                                    .filter(
                                        ([key, fingerprint]) =>
                                            key.endsWith(`:${capability.stateId}`) &&
                                            fingerprint !== capability.fingerprint,
                                    )
                                    .map(([key]) => actionName(key.slice(0, key.indexOf(':')) as ActionKind, language));
                                return (
                                    <Box
                                        component="li"
                                        key={capability.stateId}
                                        sx={{ overflowWrap: 'anywhere' }}
                                    >
                                        {capability.stateId} ({affectedActions.join(', ')})
                                    </Box>
                                );
                            })}
                        </Box>
                    </Alert>
                )}
                <Box sx={{ mt: 2, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle1">{t('ui.device_names_and_aliases')}</Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1 }}
                    >
                        {t('ui.for_example_add_light_as_an_alias_for_a_lamp_separate_aliases_wi')}
                    </Typography>
                    <Stack spacing={1}>
                        <LanguageValueTable
                            rows={aliasRows}
                            onChange={setAliasRows}
                            languageHeader={t('ui.language')}
                            valueHeader={t('ui.aliases')}
                            valueLabel={t('ui.alias_names')}
                            addLabel={t('ui.add_language')}
                            removeLabel={t('ui.remove_language')}
                        />
                        <Button
                            variant="outlined"
                            onClick={saveAliases}
                            sx={{ alignSelf: 'flex-start' }}
                        >
                            {t('ui.save_aliases')}
                        </Button>
                    </Stack>
                </Box>
                <Box sx={{ mt: 2 }}>
                    <Typography variant="subtitle1">{t('ui.action_approvals')}</Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mb: 1 }}
                    >
                        {t('ui.each_bulk_approval_shows_all_affected_actions_and_states_before_')}
                    </Typography>
                    <Stack
                        direction="row"
                        spacing={2}
                        sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}
                    >
                        {[
                            { scope: 'read' as const, label: t('ui.read'), show: hasReadActions },
                            { scope: 'write' as const, label: t('ui.write'), show: hasWriteActions },
                            {
                                scope: 'all' as const,
                                label: t('ui.read_and_write'),
                                show: hasReadActions && hasWriteActions,
                            },
                        ]
                            .filter(item => item.show)
                            .map(item => (
                                <Stack
                                    key={item.scope}
                                    direction="row"
                                    spacing={0.5}
                                    sx={{ alignItems: 'center' }}
                                >
                                    <Typography variant="body2">{item.label}</Typography>
                                    {(['grant', 'revoke'] as const).map(operation => {
                                        const count = countBatch(item.scope, operation);
                                        const title =
                                            operation === 'grant'
                                                ? `${t('ui.approve_together')}: ${item.label} (${count})`
                                                : `${t('ui.revoke_together')}: ${item.label} (${count})`;
                                        return (
                                            <Tooltip
                                                key={operation}
                                                title={title}
                                            >
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        aria-label={title}
                                                        disabled={count === 0}
                                                        onClick={() => openBatch(item.scope, operation)}
                                                    >
                                                        <BulkActionIcon
                                                            scope={item.scope}
                                                            revoke={operation === 'revoke'}
                                                        />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        );
                                    })}
                                </Stack>
                            ))}
                    </Stack>
                </Box>
                {device.discoveredCapabilities.map(capability => (
                    <Box
                        key={capability.stateId}
                        sx={{ mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
                    >
                        <Stack
                            direction="row"
                            spacing={1}
                            sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                        >
                            {capabilityIcon(capability.kind)}
                            <Typography variant="subtitle2">{capabilityName(capability.kind, language)}</Typography>
                            {capability.needsReview && (
                                <Chip
                                    size="small"
                                    color="warning"
                                    label={t('ui.review_needed')}
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
                            {capability.valueKind} ·{' '}
                            {[
                                capability.readable ? t('ui.read') : undefined,
                                capability.writable ? t('ui.write') : undefined,
                            ]
                                .filter(Boolean)
                                .join(' / ')}
                            {capability.min !== undefined ? ` · ${t('ui.minimum')} ${capability.min}` : ''}
                            {capability.max !== undefined ? ` · ${t('ui.maximum')} ${capability.max}` : ''}
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
                                        <Tooltip
                                            key={action}
                                            title={
                                                approved ? t('ui.revoke_approval') : t('ui.review_and_approve_action')
                                            }
                                        >
                                            <Chip
                                                size="small"
                                                icon={approved ? <CheckCircleIcon /> : <AddCircleOutlinedIcon />}
                                                label={actionName(action, language)}
                                                variant={approved ? 'filled' : 'outlined'}
                                                color={approved ? 'success' : 'default'}
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
                                            />
                                        </Tooltip>
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
                    <DialogTitle>{t('ui.approve_action')}</DialogTitle>
                    <DialogContent>
                        <Typography>
                            {pending ? actionName(pending.action, language) : ''} · {device.displayName}
                        </Typography>
                        <Typography sx={{ wordBreak: 'break-all' }}>{pending?.capability.stateId}</Typography>
                        <Typography
                            variant="body2"
                            sx={{ mt: 1 }}
                        >
                            {t('ui.type_range_and_mapping')} {pending?.capability.valueKind},{' '}
                            {pending?.capability.min ?? '—'}–{pending?.capability.max ?? '—'},{' '}
                            {JSON.stringify(pending?.capability.mapping ?? {})}
                        </Typography>
                        <Alert
                            severity="warning"
                            sx={{ mt: 2 }}
                        >
                            {t('ui.this_approval_applies_to_matching_commands_until_the_target_chan')}
                        </Alert>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setPending(undefined)}>{t('ui.cancel')}</Button>
                        <Button
                            variant="contained"
                            onClick={approve}
                        >
                            {t('ui.approve')}
                        </Button>
                    </DialogActions>
                </Dialog>
                <Dialog
                    open={!!batchScope}
                    onClose={() => setBatchScope(undefined)}
                    maxWidth="md"
                    fullWidth
                >
                    <DialogTitle>
                        {batchOperation === 'grant'
                            ? t('ui.approve_actions_together')
                            : t('ui.revoke_approvals_together')}
                    </DialogTitle>
                    <DialogContent>
                        <Typography sx={{ mb: 1 }}>{device.displayName}</Typography>
                        <Button
                            size="small"
                            onClick={() => setBatchSelected(batchItems.map(item => item.key))}
                        >
                            {t('ui.select_all')}
                        </Button>
                        <Stack sx={{ mt: 1 }}>
                            {batchItems.map(item => (
                                <FormControlLabel
                                    key={item.key}
                                    sx={{ alignItems: 'flex-start', mb: 1 }}
                                    control={
                                        <Checkbox
                                            checked={batchSelected.includes(item.key)}
                                            onChange={event =>
                                                setBatchSelected(current =>
                                                    event.target.checked
                                                        ? [...current, item.key]
                                                        : current.filter(key => key !== item.key),
                                                )
                                            }
                                        />
                                    }
                                    label={
                                        <Box sx={{ pt: 1 }}>
                                            <Typography variant="subtitle2">
                                                {actionName(item.action, language)} ·{' '}
                                                {capabilityName(item.capability.kind, language)}
                                            </Typography>
                                            <Typography
                                                variant="body2"
                                                sx={{ wordBreak: 'break-all' }}
                                            >
                                                {item.capability.stateId}
                                            </Typography>
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                            >
                                                {item.capability.valueKind} ·{' '}
                                                {[
                                                    item.capability.readable ? t('ui.read') : undefined,
                                                    item.capability.writable ? t('ui.write') : undefined,
                                                ]
                                                    .filter(Boolean)
                                                    .join(' / ')}
                                                {item.capability.min !== undefined
                                                    ? ` · ${t('ui.minimum')} ${item.capability.min}`
                                                    : ''}
                                                {item.capability.max !== undefined
                                                    ? ` · ${t('ui.maximum')} ${item.capability.max}`
                                                    : ''}
                                                {item.capability.unit ? ` · ${item.capability.unit}` : ''}
                                                {item.capability.mapping
                                                    ? ` · ${JSON.stringify(item.capability.mapping)}`
                                                    : ''}
                                            </Typography>
                                        </Box>
                                    }
                                />
                            ))}
                        </Stack>
                        <Alert
                            severity={batchOperation === 'grant' ? 'warning' : 'info'}
                            sx={{ mt: 1 }}
                        >
                            {batchOperation === 'grant'
                                ? t('ui.only_selected_actions_are_approved_permanently_review_target_sta')
                                : t('ui.only_the_selected_approvals_will_be_revoked')}
                        </Alert>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={() => setBatchScope(undefined)}>{t('ui.cancel')}</Button>
                        <Button
                            variant="contained"
                            disabled={batchSelected.length === 0}
                            onClick={submitBatch}
                        >
                            {batchOperation === 'grant' ? t('ui.approve_selected') : t('ui.revoke_selected')}
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
    const [functionId, setFunctionId] = useState('');
    const [capability, setCapability] = useState('');
    const [devicePage, setDevicePage] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [importDraft, setImportDraft] = useState<{ schemaVersion: number; intents: IntentDefinition[] }>();

    const refresh = useCallback(
        async (offset = 0): Promise<void> => {
            const [devices, status, model, listed] = await Promise.all([
                api.call<DeviceList>('listDevices', { offset, limit: 50, filter, room, functionId, capability }),
                api.call<Diagnostics>('getDiagnostics'),
                api.call<Training>('getTrainingStatus'),
                api.call<{ intents: IntentDefinition[] }>('listIntents'),
            ]);
            setDeviceList(devices);
            setDiagnostics(status);
            setTraining(model);
            setIntents(listed.intents);
        },
        [api, filter, room, functionId, capability],
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
            if (file.size > 65_536) throw new Error(t('error.import_too_large'));
            const data: unknown = JSON.parse(await file.text());
            if (
                !data ||
                typeof data !== 'object' ||
                !('schemaVersion' in data) ||
                data.schemaVersion !== 1 ||
                !('intents' in data) ||
                !Array.isArray(data.intents)
            )
                throw new Error(t('error.invalid_intent_import'));
            for (const intent of data.intents) validateIntentDraft(intent as IntentDefinition);
            setImportDraft(data as { schemaVersion: number; intents: IntentDefinition[] });
        } catch (error) {
            setError(displayError(error));
        }
    }

    const roomOptions = useMemo(() => deviceList.rooms ?? [], [deviceList.rooms]);
    const functionOptions = useMemo(() => deviceList.functions ?? [], [deviceList.functions]);

    return (
        <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 2, md: 3 }, pt: { xs: 2, md: 3 }, pb: 16 }}>
            <Stack
                direction="row"
                spacing={2}
                sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 2 }}
            >
                <Box>
                    <Typography variant="h4">smart-text2command</Typography>
                    <Typography color="text.secondary">
                        {t('ui.local_text_control_with_approved_device_actions')}
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
                        key={item}
                        value={item}
                        label={t(`page.${item}`)}
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
                                <Typography color="text.secondary">{t('ui.model')}</Typography>
                                <Typography variant="h5">{diagnostics.modelStatus ?? '—'}</Typography>
                                <Typography variant="caption">{diagnostics.modelVersion ?? '—'}</Typography>
                            </CardContent>
                        </Card>
                        <Card sx={{ flex: 1 }}>
                            <CardContent>
                                <Typography color="text.secondary">{t('ui.discovered_devices')}</Typography>
                                <Typography variant="h5">{diagnostics.deviceCount ?? '—'}</Typography>
                            </CardContent>
                        </Card>
                        <Card sx={{ flex: 1 }}>
                            <CardContent>
                                <Typography color="text.secondary">{t('ui.approved_devices')}</Typography>
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
                        {t('ui.refresh')}
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
                            label={t('ui.search_devices')}
                            value={filter}
                            onChange={event => {
                                setFilter(event.target.value);
                                setDevicePage(1);
                            }}
                        />
                        <TextField
                            size="small"
                            select
                            label={t('ui.room')}
                            value={room}
                            onChange={event => {
                                setRoom(event.target.value);
                                setDevicePage(1);
                            }}
                            sx={{ minWidth: 160 }}
                        >
                            <MenuItem value="">{t('ui.all_rooms')}</MenuItem>
                            <MenuItem value="__none__">{t('ui.without_room')}</MenuItem>
                            {roomOptions.map(item => (
                                <MenuItem
                                    key={item.id}
                                    value={item.id}
                                >
                                    {enumLabel(item.name, item.id, defaultLanguage)}
                                </MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            size="small"
                            select
                            label={t('ui.function')}
                            value={functionId}
                            onChange={event => {
                                setFunctionId(event.target.value);
                                setDevicePage(1);
                            }}
                            sx={{ minWidth: 160 }}
                        >
                            <MenuItem value="">{t('ui.all_functions')}</MenuItem>
                            <MenuItem value="__none__">{t('ui.without_function')}</MenuItem>
                            {functionOptions.map(item => (
                                <MenuItem
                                    key={item.id}
                                    value={item.id}
                                >
                                    {enumLabel(item.name, item.id, defaultLanguage)}
                                </MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            size="small"
                            select
                            label={t('ui.capability')}
                            value={capability}
                            onChange={event => {
                                setCapability(event.target.value);
                                setDevicePage(1);
                            }}
                            sx={{ minWidth: 170 }}
                        >
                            <MenuItem value="">{t('ui.all')}</MenuItem>
                            {Object.keys(actions).map(item => (
                                <MenuItem
                                    key={item}
                                    value={item}
                                >
                                    {capabilityName(item as Capability['kind'], defaultLanguage)}
                                </MenuItem>
                            ))}
                        </TextField>
                    </Stack>
                    <Stack
                        direction="row"
                        spacing={2}
                        sx={{ mb: 2, alignItems: 'center', justifyContent: 'space-between' }}
                    >
                        <Typography>
                            {deviceList.total} {t('ui.devices')}
                        </Typography>
                        <Button
                            startIcon={<RefreshIcon />}
                            onClick={() => void mutate('rescanDevices', {}, t('ui.devices_rescanned'))}
                        >
                            {t('ui.rescan_devices')}
                        </Button>
                    </Stack>
                    {deviceList.devices.map(device => (
                        <DeviceCard
                            key={device.id}
                            device={device}
                            language={defaultLanguage}
                            onError={setError}
                            update={payload => mutate('updateDevice', payload, t('ui.device_saved'))}
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
                        mutate('saveIntent', { intent }, t('ui.intent_saved_train_the_model_to_activate_it'))
                    }
                    onDelete={id => mutate('deleteIntent', { id }, t('ui.intent_deleted_retrain_the_model'))}
                />
            )}
            {page === 'training' && (
                <TrainingPage
                    training={training}
                    language={defaultLanguage}
                    busy={busy}
                    onTrain={() => mutate('trainModel', {}, t('ui.training_started'))}
                    onRollback={() => mutate('rollbackModel', {}, t('ui.model_rolled_back'))}
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
                        label={t('ui.default_language')}
                        value={defaultLanguage}
                        onChange={event => onDefaultLanguage(event.target.value as Language)}
                        sx={{ maxWidth: 240 }}
                    >
                        {languageOptions.map(item => (
                            <MenuItem
                                key={item.code}
                                value={item.code}
                            >
                                {item.name}
                            </MenuItem>
                        ))}
                    </TextField>
                    <Typography variant="body2">
                        {t('ui.the_language_takes_effect_after_saving_adapter_configuration')}
                    </Typography>
                    <Typography variant="h6">{t('ui.diagnostics')}</Typography>
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
                        {t('ui.refresh_diagnostics')}
                    </Button>
                    <Divider />
                    <Typography variant="h6">{t('ui.export_import_custom_intents')}</Typography>
                    <Typography variant="body2">
                        {t('ui.device_approvals_are_not_imported_train_the_model_after_importin')}
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
                            {t('ui.export')}
                        </Button>
                        <Button
                            variant="outlined"
                            component="label"
                        >
                            {t('ui.choose_json_file')}
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
                <DialogTitle>{t('ui.replace_training_data')}</DialogTitle>
                <DialogContent>
                    {t('ui.custom_intents_in_file')}: {importDraft?.intents.length}.{' '}
                    {t('ui.the_active_model_stays_unchanged_until_training')}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setImportDraft(undefined)}>{t('ui.cancel')}</Button>
                    <Button
                        color="warning"
                        onClick={() => {
                            if (!importDraft) return;
                            void mutate('importIntents', importDraft, t('ui.intents_imported'));
                            setImportDraft(undefined);
                        }}
                    >
                        {t('ui.replace')}
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
    utterances: Object.fromEntries(languageOptions.map(item => [item.code, []])),
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
    const [responseRows, setResponseRows] = useState<LanguageRow[]>(() => rowsFromValues({}, language));
    const [editingId, setEditingId] = useState<string>();
    const [error, setError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const action = draft.action ?? { kind: 'capability' as const, operation: 'turnOn' as const };
    const edit = (intent: IntentDefinition, existing = true): void => {
        setDraft(structuredClone(intent));
        setResponseRows(rowsFromValues(intent.action?.kind === 'response' ? intent.action.response : {}, language));
        setEditingId(existing ? intent.id : undefined);
        setError('');
    };
    const changeResponseRows = (rows: LanguageRow[]): void => {
        setResponseRows(rows);
        setDraft(current => ({ ...current, action: { kind: 'response', response: valuesFromRows(rows) } }));
    };
    const save = async (): Promise<void> => {
        try {
            validateIntentDraft(draft);
            if (!editingId && intents.some(item => item.id === draft.id)) {
                throw new Error(t('error.intent_id_exists'));
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
                    {t('ui.new_intent')}
                </Button>
                <Typography variant="subtitle1">{t('ui.system_intents')}</Typography>
                {intents
                    .filter(item => item.source === 'system')
                    .map(item => (
                        <Typography
                            key={item.id}
                            variant="body2"
                            sx={{ py: 0.5 }}
                        >
                            {item.id} · {(item.utterances[language] ?? []).length} {t('ui.examples')}
                        </Typography>
                    ))}
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle1">{t('ui.custom_intents')}</Typography>
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
                        <Typography variant="h6">{t('ui.edit_intent')}</Typography>
                        <TextField
                            label="ID"
                            value={draft.id}
                            disabled={intents.some(item => item.source === 'user' && item.id === draft.id)}
                            onChange={event => setDraft({ ...draft, id: event.target.value })}
                            helperText={t('ui.unique_id_e_g_mylight')}
                        />
                        <FormControlLabel
                            label={t('ui.enabled')}
                            control={
                                <Switch
                                    checked={draft.enabled}
                                    onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
                                />
                            }
                        />
                        {languageOptions.map(item => (
                            <TextField
                                key={item.code}
                                multiline
                                minRows={4}
                                label={`${t('ui.training_examples_one_per_line')} (${item.name})`}
                                value={(draft.utterances[item.code] ?? []).join('\n')}
                                onChange={event =>
                                    setDraft({
                                        ...draft,
                                        utterances: {
                                            ...draft.utterances,
                                            [item.code]: event.target.value.split('\n'),
                                        },
                                    })
                                }
                            />
                        ))}
                        <TextField
                            select
                            label={t('ui.action_type')}
                            value={action.kind}
                            onChange={event =>
                                setDraft({
                                    ...draft,
                                    action:
                                        event.target.value === 'response'
                                            ? { kind: 'response', response: valuesFromRows(responseRows) }
                                            : { kind: 'capability', operation: 'turnOn' },
                                })
                            }
                        >
                            <MenuItem value="capability">{t('ui.device_action')}</MenuItem>
                            <MenuItem value="response">{t('ui.response_template')}</MenuItem>
                        </TextField>
                        {action.kind === 'capability' ? (
                            <TextField
                                select
                                label={t('ui.operation')}
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
                                        {actionName(item, language)}
                                    </MenuItem>
                                ))}
                            </TextField>
                        ) : (
                            <LanguageValueTable
                                rows={responseRows}
                                onChange={changeResponseRows}
                                languageHeader={t('ui.language')}
                                valueHeader={t('ui.response_template')}
                                valueLabel={t('ui.response_text')}
                                addLabel={t('ui.add_language')}
                                removeLabel={t('ui.remove_language')}
                            />
                        )}
                        {error && <Alert severity="error">{error}</Alert>}
                        <Alert severity="info">
                            {t('ui.saving_changes_training_data_the_active_model_stays_in_place_unt')}
                        </Alert>
                        <Stack
                            direction="row"
                            spacing={1}
                        >
                            <Button
                                variant="contained"
                                onClick={() => void save()}
                            >
                                {t('ui.save')}
                            </Button>
                            {intents.some(item => item.source === 'user' && item.id === draft.id) && (
                                <Button
                                    color="error"
                                    onClick={() => setConfirmDelete(true)}
                                >
                                    {t('ui.delete')}
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
                <DialogTitle>{t('ui.delete_intent')}</DialogTitle>
                <DialogContent>{draft.id}</DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmDelete(false)}>{t('ui.cancel')}</Button>
                    <Button
                        color="error"
                        onClick={() => {
                            void onDelete(draft.id);
                            setConfirmDelete(false);
                            edit(emptyIntent(), false);
                        }}
                    >
                        {t('ui.delete')}
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
                    <Typography variant="h6">{t('ui.model_training')}</Typography>
                    <Typography>
                        {t('ui.status')}: {training.status}
                    </Typography>
                    <Typography>
                        {t('ui.model_version')}: {training.version ?? training.modelVersion ?? '—'}
                    </Typography>
                    <Typography>
                        {t('ui.regression')}: {training.regressionPassed ?? '—'} / {training.regressionTotal ?? '—'}
                    </Typography>
                    {training.error && <Alert severity="error">{training.error}</Alert>}
                    {training.status === 'running' && <LinearProgressFallback language={language} />}
                    <Stack
                        direction="row"
                        spacing={1}
                    >
                        <Button
                            variant="contained"
                            disabled={busy || training.status === 'running'}
                            onClick={() => void onTrain()}
                        >
                            {t('ui.start_training')}
                        </Button>
                        <Button
                            variant="outlined"
                            disabled={busy || training.status === 'running'}
                            onClick={() => setConfirmRollback(true)}
                        >
                            {t('ui.activate_previous_model')}
                        </Button>
                    </Stack>
                    <Alert severity="info">
                        {t('ui.training_runs_in_the_background_the_active_model_changes_only_af')}
                    </Alert>
                    <Dialog
                        open={confirmRollback}
                        onClose={() => setConfirmRollback(false)}
                    >
                        <DialogTitle>{t('ui.roll_back_model')}</DialogTitle>
                        <DialogActions>
                            <Button onClick={() => setConfirmRollback(false)}>{t('ui.cancel')}</Button>
                            <Button
                                onClick={() => {
                                    void onRollback();
                                    setConfirmRollback(false);
                                }}
                            >
                                {t('ui.roll_back')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                </Stack>
            </CardContent>
        </Card>
    );
}

function LinearProgressFallback({ language }: { language: Language }): React.JSX.Element {
    return (
        <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center' }}
        >
            <CircularProgress size={18} />
            <Typography variant="body2">{labels(language)('ui.training_in_progress')}</Typography>
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
            if (!selection && (!text.trim() || text.length > 1000)) throw new Error(t('error.text_length'));
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
                    <Typography variant="h6">{t('ui.test_lab')}</Typography>
                    <TextField
                        label={t('ui.command')}
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
                            label={t('ui.language')}
                            value={selectedLanguage}
                            onChange={event => setSelectedLanguage(event.target.value as Language)}
                            sx={{ minWidth: 140 }}
                        >
                            {languageOptions.map(item => (
                                <MenuItem
                                    key={item.code}
                                    value={item.code}
                                >
                                    {item.name}
                                </MenuItem>
                            ))}
                        </TextField>
                        <FormControlLabel
                            label={t('ui.execute')}
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
                            {mode === 'execute' ? t('ui.review_execution') : t('ui.analyze')}
                        </Button>
                    </Stack>
                    {mode === 'execute' && (
                        <Alert severity="warning">{t('ui.execution_uses_only_approved_actions')}</Alert>
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
                                <Chip label={`${t('ui.intent')}: ${result.intent ?? '—'}`} />
                                <Chip label={`${t('ui.confidence')}: ${result.confidence?.toFixed(3) ?? '—'}`} />
                                <Chip label={`${t('ui.model')}: ${result.modelVersion ?? '—'}`} />
                            </Stack>
                            {result.candidates?.length ? (
                                <Typography sx={{ mt: 2 }}>
                                    {t('ui.device_candidates')}:{' '}
                                    {result.candidates
                                        .map(item => `${item.deviceId} (${item.score.toFixed(2)})`)
                                        .join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.alternatives?.length ? (
                                <Typography sx={{ mt: 1 }}>
                                    {t('ui.intent_ranking')}:{' '}
                                    {result.analysis.alternatives
                                        .slice(0, 5)
                                        .map(item => `${item.intent} (${item.confidence.toFixed(2)})`)
                                        .join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.entities?.length ? (
                                <Typography sx={{ mt: 1 }}>
                                    {t('ui.entities')}:{' '}
                                    {result.analysis.entities.map(item => `${item.type}=${item.value}`).join(', ')}
                                </Typography>
                            ) : null}
                            {result.analysis?.plan && (
                                <Typography sx={{ mt: 1 }}>
                                    {t('ui.planned_access')}: {result.analysis.plan.operation}{' '}
                                    {result.analysis.plan.stateId}{' '}
                                    {result.analysis.plan.value !== undefined ? `= ${result.analysis.plan.value}` : ''}{' '}
                                    · {t('ui.policy')}: {result.analysis.policyDecision ?? '—'}
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
                        <DialogTitle>{t('ui.execute_command')}</DialogTitle>
                        <DialogContent>{text}</DialogContent>
                        <DialogActions>
                            <Button onClick={() => setConfirm(false)}>{t('ui.cancel')}</Button>
                            <Button
                                color="warning"
                                variant="contained"
                                onClick={() => {
                                    setConfirm(false);
                                    void submit();
                                }}
                            >
                                {t('ui.execute')}
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
