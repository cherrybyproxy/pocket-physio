const cvTest = `
<!DOCTYPE html>
<html>
<head>
    <script async src="https://docs.opencv.org/4.8.0/opencv.js" onload="checkCV()" type="text/javascript"></script>
    <script>
        function checkCV() {
            setTimeout(() => {
                const trackers = [
                    'TrackerMIL_create', 'TrackerKCF_create', 'TrackerCSRT_create', 
                    'TrackerMOSSE_create', 'TrackerMedianFlow_create', 'CamShift', 'meanShift',
                    'calcOpticalFlowFarneback', 'calcOpticalFlowPyrLK', 'phaseCorrelate', 'matchTemplate'
                ];
                let out = {};
                for (const t of trackers) {
                    out[t] = typeof cv[t] !== 'undefined';
                }
                console.log(JSON.stringify(out));
                document.body.innerHTML = JSON.stringify(out);
            }, 1000);
        }
    </script>
</head>
<body>Loading...</body>
</html>
`;
require('fs').writeFileSync('cv_test.html', cvTest);
