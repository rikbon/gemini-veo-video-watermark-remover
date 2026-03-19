document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const uploadContent = document.querySelector('.drop-zone__content');
    
    const processingState = document.getElementById('processing-state');
    const successState = document.getElementById('success-state');
    const errorState = document.getElementById('error-state');
    const progressBar = document.getElementById('progress-bar');
    const statusText = document.getElementById('status-text');
    const errorMessage = document.getElementById('error-message');
    
    const downloadBtn = document.getElementById('download-btn');
    const resetBtn = document.getElementById('reset-btn');
    const errorResetBtn = document.getElementById('error-reset-btn');

    let processedFileBlob = null;
    let processedFileName = '';

    // Click to upload
    dropZone.addEventListener('click', () => fileInput.click());

    // Drag and drop handlers
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleFile(files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        if (!file.type.startsWith('video/')) {
            showError('Please upload a valid video file.');
            return;
        }

        if (file.size > 150 * 1024 * 1024) {
            showError('File is too large. Max size is 150MB.');
            return;
        }

        startProcessing(file);
    }

    async function startProcessing(file) {
        // Switch states
        dropZone.classList.add('hidden');
        processingState.classList.remove('hidden');
        successState.classList.add('hidden');
        errorState.classList.add('hidden');
        
        progressBar.style.width = '5%';
        statusText.innerText = 'Uploading video to secure engine...';

        const formData = new FormData();
        formData.append('video', file);

        try {
            // We use XMLHttpRequest for progress tracking
            const xhr = new XMLHttpRequest();
            
            xhr.open('POST', '/process-video', true);
            xhr.responseType = 'blob';

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 40); // Upload is first 40%
                    progressBar.style.width = `${percent}%`;
                    if (percent > 35) statusText.innerText = 'Processing frames and restoring pixels...';
                }
            };

            // Simulate the processing progress after upload
            let internalProgress = 40;
            const progressInterval = setInterval(() => {
                if (internalProgress < 95) {
                    internalProgress += 1;
                    progressBar.style.width = `${internalProgress}%`;
                }
            }, 800);

            xhr.onload = async () => {
                clearInterval(progressInterval);
                if (xhr.status === 200) {
                    progressBar.style.width = '100%';
                    statusText.innerText = 'Finalizing...';
                    
                    processedFileBlob = xhr.response;
                    processedFileName = `clean-${file.name}`;
                    
                    setTimeout(() => {
                        showSuccess();
                    }, 500);
                } else {
                    const reader = new FileReader();
                    reader.onload = () => {
                        try {
                            const errorData = JSON.parse(reader.result);
                            showError(errorData.error || 'Processing failed');
                        } catch (e) {
                            showError('Processing failed with server error');
                        }
                    };
                    reader.readAsText(xhr.response);
                }
            };

            xhr.onerror = () => {
                clearInterval(progressInterval);
                showError('Network error occurred.');
            };

            xhr.send(formData);

        } catch (error) {
            showError(error.message);
        }
    }

    function showSuccess() {
        processingState.classList.add('hidden');
        successState.classList.remove('hidden');
    }

    function showError(msg) {
        errorMessage.innerText = msg;
        dropZone.classList.add('hidden');
        processingState.classList.add('hidden');
        successState.classList.add('hidden');
        errorState.classList.remove('hidden');
    }

    downloadBtn.addEventListener('click', () => {
        if (!processedFileBlob) return;
        
        const url = window.URL.createObjectURL(processedFileBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = processedFileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
    });

    const resetUI = () => {
        dropZone.classList.remove('hidden');
        processingState.classList.add('hidden');
        successState.classList.add('hidden');
        errorState.classList.add('hidden');
        fileInput.value = '';
        processedFileBlob = null;
    };

    resetBtn.addEventListener('click', resetUI);
    errorResetBtn.addEventListener('click', resetUI);
});
