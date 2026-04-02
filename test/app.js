document.addEventListener('DOMContentLoaded', () => {
    fetch('data.json')
        .then(response => response.json())
        .then(data => {
            const jsonData = document.getElementById('jsonData');
            jsonData.innerHTML = `
                <p>Name: ${data.name}</p>
                <p>Age: ${data.age}</p>
                <p>City: ${data.city}</p>
            `;
        })
        .catch(error => console.error('Error:', error));
});