import { useLocation, useNavigate } from 'react-router-dom';

export function TestWorldControls({ deepLink }: { deepLink: string }) {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<output data-testid="location">{`${location.pathname}${location.search}`}</output>
			<button type="button" data-testid="deeplink" onClick={() => void navigate(deepLink)}>
				deeplink
			</button>
			<button type="button" data-testid="history-back" onClick={() => void navigate(-1)}>
				back
			</button>
			<button type="button" data-testid="history-forward" onClick={() => void navigate(1)}>
				forward
			</button>
		</>
	);
}
